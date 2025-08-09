import express from "express";
import axios from "axios";
import crypto from "crypto";
import { createClient } from "redis";

const app = express();
app.use(express.json());

const redis = createClient({ url: "redis://redis:6379" });
await redis.connect();

const VROOM_URL = "http://vroom:3000";

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
    });

    // Only cache if successful
    if (vroomRes.status === 200) {
      await redis.setEx(key, 3600, JSON.stringify(vroomRes.data)); // 1 hour
    }

    res.set("X-Cache", "MISS");
    res.status(vroomRes.status).json(vroomRes.data);
  } catch (err) {
    console.error("Error:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.listen(4000, () => {
  console.log("Cache proxy running on port 4000");
});
