import type { NextConfig } from "next";
import { getEnv } from "./src/lib/env";

getEnv();

const config: NextConfig = {};

export default config;
