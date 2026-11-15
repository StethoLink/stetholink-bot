import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: { externalDir: true },
  devIndicators: false,
};

export default nextConfig;
