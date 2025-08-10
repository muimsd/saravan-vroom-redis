import 'dotenv/config';
import express from "express";
import axios from "axios";
import crypto from "crypto";
import { createClient } from "redis";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const REDIS_URL = process.env.REDIS_URL || "redis://redis:6379";
const redis = createClient({ url: REDIS_URL });
redis.on("error", (e) => console.error("Redis error:", e.message));
await redis.connect();

const VROOM_URL = process.env.VROOM_URL || "http://vroom:3000";
try {
  // Validate base URL once at startup for early feedback
  // eslint-disable-next-line no-new
  new URL(VROOM_URL);
} catch (e) {
  console.warn("VROOM_URL appears invalid:", e.message);
}

// Helper to create a cache key
function makeKey(body) {
  return (
    "vroom:" +
    crypto.createHash("md5").update(JSON.stringify(body)).digest("hex")
  );
}

app.post("/", async (req, res) => {
  const key = makeKey(req.body);

  try {
    // Check cache
    const cached = await redis.get(key);
    if (cached) {
      res.set("X-Cache", "HIT");
      return res.json(JSON.parse(cached));
    }

    // Forward to VROOM
    const vroomRes = await axios.post(VROOM_URL, req.body, {
      headers: { "Content-Type": "application/json" },
      timeout: 60_000,
      // Prevent axios from trying to parse an unexpected 'url' prop in body as config
      validateStatus: () => true, // we will handle status codes manually
    });

    // Only cache if successful
    if (vroomRes.status === 200) {
      await redis.setEx(key, 3600, JSON.stringify(vroomRes.data)); // 1 hour
    }

    res.set("X-Cache", "MISS");
    res.status(vroomRes.status).json(vroomRes.data);
  } catch (err) {
    // Provide richer diagnostics and pass through upstream errors when possible
    const isAxios = !!(err && err.isAxiosError);
    if (isAxios && err.response) {
      console.error(
        "Upstream error:",
        JSON.stringify(
          {
            status: err.response.status,
            statusText: err.response.statusText,
            url: err.config?.url,
            method: err.config?.method,
          },
          null,
          2
        )
      );
      return res.status(err.response.status).json(
        typeof err.response.data === "object"
          ? err.response.data
          : { error: String(err.response.data) }
      );
    }

    if (isAxios && err.request) {
      console.error("Request error:", err.code || err.message, {
        url: err.config?.url,
        method: err.config?.method,
      });
      return res
        .status(502)
        .json({ error: "Bad gateway to VROOM", code: err.code || "EAXIOS" });
    }

    console.error("Error:", err && err.message ? err.message : err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Simple health endpoint
app.get("/health", (req, res) => {
  res.json({ ok: true, vroom: VROOM_URL, redis: REDIS_URL });
});

app.listen(4000, () => {
  console.log("Cache proxy running on port 4000");
});
