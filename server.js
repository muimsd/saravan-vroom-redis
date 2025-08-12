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

// Health check helper for OSRM services
async function checkOSRMHealth(baseUrl, profile) {
  const testRoute = "77.1025,28.7041;77.1125,28.7141";
  const url = `${baseUrl}/route/v1/driving/${testRoute}`;
  
  try {
    const response = await axios.get(url, { 
      timeout: 5000,
      validateStatus: (status) => status < 500 // Accept 4xx as "reachable"
    });
    return {
      profile,
      url: baseUrl,
      status: response.status,
      ok: response.status < 400,
      message: response.status < 400 ? "OK" : `HTTP ${response.status}`
    };
  } catch (error) {
    return {
      profile,
      url: baseUrl,
      status: 0,
      ok: false,
      message: error.code || error.message || "Connection failed"
    };
  }
}

// Health check helper for VROOM service with specific profile
async function checkVroomHealth(baseUrl, profile) {
  const testRequest = {
    vehicles: [{
      id: 1,
      profile: profile,
      start: [77.2197, 28.6328]
    }],
    jobs: [{
      id: 1,
      location: [77.2295, 28.6129]
    }]
  };

  try {
    const response = await axios.post(baseUrl, testRequest, {
      headers: { "Content-Type": "application/json" },
      timeout: 5000,
      validateStatus: (status) => status < 500
    });
    return {
      service: "vroom",
      profile: profile,
      url: baseUrl,
      status: response.status,
      ok: response.status < 400,
      message: response.status < 400 ? "OK" : `HTTP ${response.status}`
    };
  } catch (error) {
    return {
      service: "vroom",
      profile: profile,
      url: baseUrl,
      status: 0,
      ok: false,
      message: error.code || error.message || "Connection failed"
    };
  }
}

// Health check helper for Redis service
async function checkRedisHealth() {
  try {
    const pong = await redis.ping();
    return {
      service: "redis",
      url: REDIS_URL,
      status: 200,
      ok: pong === "PONG",
      message: pong === "PONG" ? "OK" : "Unexpected ping response"
    };
  } catch (error) {
    return {
      service: "redis",
      url: REDIS_URL,
      status: 0,
      ok: false,
      message: error.message || "Connection failed"
    };
  }
}

// Enhanced health endpoint with all service checks
app.get("/health", async (req, res) => {
  const [osrmChecks, vroomChecks, redisCheck] = await Promise.all([
    Promise.all([
      checkOSRMHealth("http://osrm-motorbike:5000", "motorbike"),
      checkOSRMHealth("http://osrm-small-truck:5000", "smalltruck")
    ]),
    Promise.all([
      checkVroomHealth(VROOM_URL, "motorbike"),
      checkVroomHealth(VROOM_URL, "smalltruck")
    ]),
    checkRedisHealth()
  ]);

  const allHealthy = [
    ...osrmChecks,
    ...vroomChecks,
    redisCheck
  ].every(check => check.ok);
  
  res.json({ 
    ok: allHealthy, 
    services: {
      vroom_profiles: vroomChecks,
      redis: redisCheck,
      osrm_profiles: osrmChecks
    }
  });
});

app.listen(4000, () => {
  console.log("Cache proxy running on port 4000");
});
