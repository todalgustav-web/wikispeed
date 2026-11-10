/*
 * Net — room networking for Wiki Speedrun.
 *
 * How it works:
 *  - Players never connect to each other directly (no WebRTC), so nobody can see
 *    another player's IP address. All messages go through public MQTT brokers
 *    over secure WebSockets (wss://), which act as a dumb relay.
 *  - The room code is never sent anywhere. It is hashed into a random-looking
 *    topic name, and also turned into an AES-256-GCM key that encrypts every
 *    message. The broker only ever sees encrypted noise.
 *  - We connect to several brokers at once and de-duplicate messages, so the
 *    game keeps working if one public broker is down.
 */
const Net = (() => {
  "use strict";

  // Public MQTT-over-WebSocket brokers. No account needed.
  // You can override these with ?broker=wss://your-broker/mqtt (repeatable).
  const DEFAULT_BROKERS = [
    "wss://broker.emqx.io:8084/mqtt",
    "wss://broker.hivemq.com:8884/mqtt",
  ];
  const TOPIC_PREFIX = "wikispeedrun/v1/";
  const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 32 chars, no 0/O/1/I
  const CODE_LENGTH = 6;

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function brokers() {
    const custom = new URLSearchParams(location.search).getAll("broker")
      .filter((u) => /^wss?:\/\//.test(u));
    return custom.length ? custom : DEFAULT_BROKERS;
  }

  function newCode() {
    const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
    return [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("");
  }

  function normalizeCode(s) {
    return (s || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, CODE_LENGTH);
  }

  function isValidCode(s) {
    return s.length === CODE_LENGTH && [...s].every((c) => ALPHABET.includes(c));
  }

  function randomId() {
    return [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const toB64 = (bytes) => btoa(String.fromCharCode(...bytes));
  const fromB64 = (str) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0));

  async function deriveRoomSecrets(code) {
    const digest = await crypto.subtle.digest("SHA-256", enc.encode("wikispeedrun-topic:" + code));
    const topic = TOPIC_PREFIX + toHex(digest).slice(0, 32);
    const base = await crypto.subtle.importKey("raw", enc.encode(code), "PBKDF2", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: enc.encode("wikispeedrun-v1"), iterations: 100000, hash: "SHA-256" },
      base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
    );
    return { topic, key };
  }

  class Room {
    /**
     * @param {string} code    room code
     * @param {string} me      this player's random id
     * @param {(from:string, type:string, data:any) => void} onMessage
     * @param {(connected:number, total:number) => void} onStatus
     */
    constructor(code, me, onMessage, onStatus) {
      this.code = code;
      this.me = me;
      this.onMessage = onMessage;
      this.onStatus = onStatus || (() => {});
      this.clients = [];
      this.seen = new Set();
      this.seenQueue = [];
      this.closed = false;
    }

    connectedCount() {
      return this.clients.filter((c) => c.connected).length;
    }

    async connect(timeoutMs = 10000) {
      if (typeof mqtt === "undefined") throw new Error("Networking library failed to load.");
      const { topic, key } = await deriveRoomSecrets(this.code);
      this.topic = topic;
      this.key = key;

      const urls = brokers();
      const report = () => this.onStatus(this.connectedCount(), urls.length);

      this.clients = urls.map((url) => {
        const c = mqtt.connect(url, {
          clientId: "wsr_" + randomId(),
          clean: true,
          keepalive: 30,
          connectTimeout: 8000,
          reconnectPeriod: 3000,
          protocolVersion: 4,
        });
        c.on("connect", () => { c.subscribe(topic, { qos: 0 }); report(); });
        c.on("close", report);
        c.on("offline", report);
        c.on("error", () => { /* handled by reconnect */ });
        c.on("message", (_t, payload) => this._receive(payload.toString()));
        return c;
      });

      // Resolve as soon as one broker is connected.
      await new Promise((resolve, reject) => {
        const started = Date.now();
        const tick = setInterval(() => {
          if (this.connectedCount() > 0) { clearInterval(tick); resolve(); }
          else if (Date.now() - started > timeoutMs) {
            clearInterval(tick);
            this.close();
            reject(new Error("Couldn't reach the multiplayer servers. Check your connection or try again."));
          }
        }, 100);
      });
    }

    async send(type, data = {}) {
      if (this.closed) return;
      const msg = JSON.stringify({ i: randomId(), f: this.me, t: type, d: data });
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, this.key, enc.encode(msg)));
      const packet = new Uint8Array(iv.length + ct.length);
      packet.set(iv);
      packet.set(ct, iv.length);
      const b64 = toB64(packet);
      this.clients.forEach((c) => { if (c.connected) c.publish(this.topic, b64, { qos: 0 }); });
    }

    async _receive(b64) {
      try {
        const packet = fromB64(b64);
        const plain = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: packet.slice(0, 12) }, this.key, packet.slice(12),
        );
        const msg = JSON.parse(dec.decode(plain));
        if (!msg || typeof msg.i !== "string" || typeof msg.f !== "string" || typeof msg.t !== "string") return;
        if (this.seen.has(msg.i)) return; // same message via another broker
        this.seen.add(msg.i);
        this.seenQueue.push(msg.i);
        if (this.seenQueue.length > 500) this.seen.delete(this.seenQueue.shift());
        if (msg.f === this.me) return; // our own echo
        this.onMessage(msg.f, msg.t, msg.d || {});
      } catch {
        /* not for us / corrupted — ignore */
      }
    }

    close() {
      this.closed = true;
      this.clients.forEach((c) => { try { c.end(true); } catch { /* ignore */ } });
      this.clients = [];
    }
  }

  return { Room, newCode, normalizeCode, isValidCode, randomId };
})();
