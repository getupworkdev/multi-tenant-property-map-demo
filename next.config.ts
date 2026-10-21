import type { NextConfig } from 'next'

// Every page depends on the signed-in user's tenant, so pages render per request;
// Cache Components are left off.
const nextConfig: NextConfig = {
  turbopack: { root: process.cwd() },
}

export default nextConfig
