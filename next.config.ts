import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Dockerデプロイ用: .next/standalone に必要最小限のファイルのみをまとめて出力する
  output: "standalone",
};

export default nextConfig;
