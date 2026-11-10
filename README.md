# 🏁 Wiki Speedrun

Race your friends from one Wikipedia article to another using only the links inside the articles. Fastest time wins.

**100% static.** Plain HTML, CSS and JavaScript with no build step and no backend to run. It works on GitHub Pages as-is.

## Features

- 👥 **Multiplayer rooms**: create a room, share the 6-character code or invite link, and race live
- 🙈 **No sign-up**: just pick a nickname
- 🔒 **IP-private and encrypted**: players never connect to each other (see below)
- 👑 **Host controls**: the host picks the language and route, and if the host leaves, someone else takes over automatically
- 📊 **Live race board**: see everyone's click count and current article while you race
- 🏃 **Jump in late**: join a race that's already running (your own clock starts when you do)
- 🧍 **Solo mode**: daily challenge, random routes and custom routes, with a local best-runs list
- 🌍 **Languages**: English, Norsk (bokmål and nynorsk), Svenska, Dansk, Deutsch, Français, Español, Simple English
- 🌙 Dark mode, mobile friendly

## How multiplayer works (and why your IP stays hidden)

Most browser multiplayer games without a server use WebRTC, which connects players directly and **reveals everyone's IP address** to the others. This project doesn't do that.

- All messages go through **public MQTT brokers** (`broker.emqx.io` and `broker.hivemq.com`) over secure WebSockets. Players only talk to the broker, never to each other, so **other players can't see your IP**.
- The **room code is never sent** anywhere. It's hashed into a random topic name and turned into an **AES-256-GCM key** (via PBKDF2), so every message is end-to-end encrypted. The broker only relays encrypted data.
- The game connects to two brokers at once and drops duplicate messages, so it keeps working if one is down.

Honest caveats:

- The broker operators (and Wikipedia, which serves the articles) can see your IP address, just like any website you visit. Other players cannot.
- The public brokers are free test services with no uptime guarantee. For a big audience, run your own (see below).
- Times are measured in each player's browser, so a determined cheater could fake a result. It's a game for friends.

### Using your own broker

Any MQTT broker with WebSocket support works (for example Mosquitto, EMQX or HiveMQ). You can:

- edit `DEFAULT_BROKERS` at the top of `net.js`, or
- add `?broker=wss://your-broker.example.com/mqtt` to the URL (repeatable). Invite links keep this setting.

## Run it locally

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

(Opening `index.html` directly as a file also works in most browsers.)

## Put it on GitHub Pages

1. Create a new repository on GitHub (for example `wiki-speedrun`).
2. Upload all the files, including the `lib` folder. Drag and drop on the GitHub website works, or:
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/wiki-speedrun.git
   git push -u origin main
   ```
3. In the repo, go to **Settings → Pages**, set **Source** to *Deploy from a branch*, choose `main` and `/ (root)`, then click **Save**.
4. After a minute the game is live at `https://YOUR-USERNAME.github.io/wiki-speedrun/`.

## Project structure

```
index.html          page layout (menu, lobby, game, results)
style.css           styling (light and dark mode)
app.js              game logic, solo and multiplayer
net.js              encrypted room networking over MQTT
lib/mqtt.min.js     MQTT.js 5.16.1 (MIT), vendored so there's no CDN dependency
```

## Contributing

Pull requests are welcome! Some ideas:

- Daily challenge pools for non-English Wikipedias
- Room chat and emoji reactions
- More game modes: "no back button", time limits, "fewest clicks wins"
- Show the shortest possible path after a race

## License

Code: [MIT](LICENSE). MQTT.js is MIT licensed (see `lib/mqtt.LICENSE.md`).
Article content is from [Wikipedia](https://www.wikipedia.org) under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). This project is not affiliated with the Wikimedia Foundation.
