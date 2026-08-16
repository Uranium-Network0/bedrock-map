import express from "express";
import { WebSocketServer } from "ws";
import http from "http";

const app = express();
app.use(express.json({ limit: "5mb" }));

const API_KEY = process.env.BEDROCK_API_KEY;

// In-memory world state
const blocks = new Map();  // key: "dim:x:y:z" -> {x,y,z,dimension,type}
const players = new Map(); // key: name -> {name,x,y,z,dimension}

// --- HTTP endpoints ---

// One-off snapshot, useful for the initial page load
app.get("/state", (req, res) => {
  res.json({
    blocks: Array.from(blocks.values()),
    players: Array.from(players.values()),
  });
});

// Bedrock server posts block/player updates here
app.post("/update", (req, res) => {
  const key = req.headers["x-api-key"];
  if (!API_KEY || key !== API_KEY) {
    return res.status(401).send("Unauthorized");
  }

  const payload = req.body || {};
  const changedBlocks = [];

  if (Array.isArray(payload.blocks)) {
    for (const b of payload.blocks) {
      if (
        typeof b.x !== "number" || typeof b.y !== "number" ||
        typeof b.z !== "number" || typeof b.type !== "string"
      ) continue;

      const dim = b.dimension || "overworld";
      const mapKey = `${dim}:${b.x}:${b.y}:${b.z}`;

      if (b.type === "minecraft:air") {
        blocks.delete(mapKey);
      } else {
        blocks.set(mapKey, { x: b.x, y: b.y, z: b.z, dimension: dim, type: b.type });
      }
      changedBlocks.push({ x: b.x, y: b.y, z: b.z, dimension: dim, type: b.type });
    }
  }

  if (Array.isArray(payload.players)) {
    for (const p of payload.players) {
      if (!p.name) continue;
      players.set(p.name, {
        name: p.name, x: p.x, y: p.y, z: p.z, dimension: p.dimension || "overworld",
      });
    }
  }

  broadcast({ type: "delta", blocks: changedBlocks, players: payload.players || [] });
  res.send("OK");
});

app.get("/", (req, res) => {
  res.send("Bedrock live map backend is running.");
});

// --- WebSocket ---

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  // Send full current state to the newly connected browser
  ws.send(JSON.stringify({
    type: "snapshot",
    blocks: Array.from(blocks.values()),
    players: Array.from(players.values()),
  }));
});

function broadcast(message) {
  const data = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) {
      client.send(data);
    }
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`);
});
