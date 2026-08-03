import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@feedback-code/next"],
  output: "standalone"
};

export default nextConfig;
