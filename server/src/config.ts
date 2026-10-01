import path from 'node:path';

export const config = {
  port: Number(process.env.PORT || 3000),
  databaseUrl: process.env.DATABASE_URL || 'postgres://studio:studio@localhost:5432/studio',
  dataDir: path.resolve(process.env.DATA_DIR || './data'),
  exportRoot: path.resolve(process.env.EXPORT_ROOT || './exports'),
  webDist: path.resolve(process.env.WEB_DIST || '../web/dist'),
  // Host path shown to the user for exported files (the container only sees /exports).
  exportRootLabel: process.env.EXPORT_ROOT_LABEL || process.env.EXPORT_ROOT || './exports',
  adminUsername: process.env.ADMIN_USERNAME || '',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  spicyApiKey: process.env.SPICY_API_KEY || '',
  spicyApiBase: process.env.SPICY_API_BASE || 'https://api.spicyapi.ai/api/v1',
  higgsfieldMcpUrl: process.env.HIGGSFIELD_MCP_URL || 'https://mcp.higgsfield.ai/mcp',
};

export const mediaDir = () => path.join(config.dataDir, 'media');
