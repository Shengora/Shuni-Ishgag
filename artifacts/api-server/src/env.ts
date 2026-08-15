import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dotenvPath = path.join(__dirname, "../.env");
console.log("[env.ts] Loading .env from:", dotenvPath);
dotenv.config({ path: dotenvPath });
