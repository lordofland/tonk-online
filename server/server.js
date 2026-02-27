// server/server.js
const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Serve your client files (index.html, app.js, styles.css, assets/)
app.use(express.static(path.join(__dirname, "..")));

io.on("connection", (socket) => {
  console.log("socket connected", socket.id);

  // You will expand these events when you wire real multiplayer game state
  socket.on("ping", () => socket.emit("pong"));
});

server.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});