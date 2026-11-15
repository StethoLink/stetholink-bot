// Plain JavaScript on purpose: the production image has no TypeScript compiler, and Next would
// try to install one at start to read a .ts configuration file.
/** @type {import("next").NextConfig} */
const nextConfig = {
  experimental: { externalDir: true },
  devIndicators: false,
};
export default nextConfig;
