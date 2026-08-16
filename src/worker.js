import { DurableObject } from "cloudflare:workers";

// Durable Object: holds the current world/build state in memory + storage,
// accepts updates from the Bedrock server, and broadcasts to connected
// browser clients over WebSocket.
export class WorldMapState extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.state = ctx;
    this.env = env;
    this.sessions = [];
    this.blocks = new Map();  // key: "dim:x:y:z" -> {x,y,z,dimension,type}
    this.players = new Map(); // key: name -> {name,x,y,z,dimension}

    // Restore persisted blocks on cold start
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get("blocks");
      if (stored) this.blocks = new Map(stored);
    });
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/ws") return this.handleWebSocket(request);
    if (url.pathname === "/update" && request.method === "POST") {
      return this.handleUpdate(request);
    }
    if (url.pathname === "/state" && request.method === "GET") {
      return Response.json({
        blocks: Array.from(this.blocks.values()),
        players: Array.from(this.players.values()),
      });
    }

    return new Response("Not found", { status: 404 });
  }

  handleWebSocket(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.sessions.push(server);

    // Send full current state to the newly connected browser
    server.send(JSON.stringify({
      type: "snapshot",
      blocks: Array.from(this.blocks.values()),
      players: Array.from(this.players.values()),
    }));

    const drop = () => {
      this.sessions = this.sessions.filter((s) => s !== server);
    };
    server.addEventListener("close", drop);
    server.addEventListener("error", drop);

    return new Response(null, { status: 101, webSocket: client });
  }

  async handleUpdate(request) {
    // Simple shared-secret auth so randoms can't poison your map data
    const key = request.headers.get("x-api-key");
    if (!this.env.BEDROCK_API_KEY || key !== this.env.BEDROCK_API_KEY) {
      return new Response("Unauthorized", { status: 401 });
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return new Response("Bad JSON", { status: 400 });
    }

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
          this.blocks.delete(mapKey);
        } else {
          this.blocks.set(mapKey, { x: b.x, y: b.y, z: b.z, dimension: dim, type: b.type });
        }
        changedBlocks.push({ x: b.x, y: b.y, z: b.z, dimension: dim, type: b.type });
      }
      // Persist without blocking the response/broadcast
      this.state.storage.put("blocks", Array.from(this.blocks.entries()));
    }

    if (Array.isArray(payload.players)) {
      for (const p of payload.players) {
        if (!p.name) continue;
        this.players.set(p.name, {
          name: p.name, x: p.x, y: p.y, z: p.z, dimension: p.dimension || "overworld",
        });
      }
    }

    this.broadcast({
      type: "delta",
      blocks: changedBlocks,
      players: payload.players || [],
    });

    return new Response("OK");
  }

  broadcast(message) {
    const data = JSON.stringify(message);
    this.sessions = this.sessions.filter((session) => {
      try {
        session.send(data);
        return true;
      } catch {
        return false;
      }
    });
  }
}

// Router: everything goes to a single Durable Object instance named "main-map"
export default {
  async fetch(request, env) {
    const id = env.WORLD_MAP.idFromName("main-map");
    const stub = env.WORLD_MAP.get(id);
    return stub.fetch(request);
  },
};
