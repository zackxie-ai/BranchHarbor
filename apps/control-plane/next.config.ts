import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["pg", "@temporalio/client", "@temporalio/common"],
};

export default nextConfig;
