import axios, { AxiosResponse } from 'axios';
import type {
  PaginatedResponse,
  SandboxDto,
  CreateSandboxDto,
  CommandResult,
  SandboxStatusResult,
  SandboxProfileDto,
  CreateSandboxProfileDto,
  UpdateSandboxProfileDto,
  AvailableMcpTool,
  McpProfileDto,
  CreateMcpProfileDto,
  UpdateMcpProfileDto,
  SnapshotDto,
  CreateSnapshotDto,
  RestoreSnapshotDto,
  UsageSummary,
} from './types';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '/api/v1',
  headers: { 'Content-Type': 'application/json' },
});

// Auth interceptor
api.interceptors.request.use((config) => {
  const apiKey = localStorage.getItem('devic-sandbox-api-key');
  if (apiKey) {
    config.headers.Authorization = `Bearer ${apiKey}`;
  }
  return config;
});

// Redirect to /settings when the API rejects the credentials. Skip the redirect
// for the settings page itself (so its "Test connection" button surfaces 401
// inline) and for an already-current /settings location.
let redirectingForAuth = false;
api.interceptors.response.use(
  (res) => res,
  (err) => {
    const status = err?.response?.status;
    if (status === 401 || status === 403) {
      const onSettings = window.location.pathname.startsWith('/settings');
      if (!onSettings && !redirectingForAuth) {
        redirectingForAuth = true;
        setTimeout(() => {
          redirectingForAuth = false;
        }, 2000);
        window.location.assign('/settings');
      }
    }
    return Promise.reject(err);
  },
);

// Sandboxes
export const sandboxesApi = {
  getAll(params?: { limit?: number; offset?: number; status?: string }): Promise<AxiosResponse<PaginatedResponse<SandboxDto>>> {
    return api.get('/sandboxes', { params });
  },
  getOne(id: string): Promise<AxiosResponse<SandboxDto>> {
    return api.get(`/sandboxes/${id}`);
  },
  getStatus(id: string): Promise<AxiosResponse<SandboxStatusResult>> {
    return api.get(`/sandboxes/${id}/status`);
  },
  create(dto: CreateSandboxDto): Promise<AxiosResponse<SandboxDto>> {
    return api.post('/sandboxes', dto);
  },
  runCommand(id: string, command: string, cwd?: string): Promise<AxiosResponse<CommandResult>> {
    return api.post(`/sandboxes/${id}/command`, { command, cwd });
  },
  stop(id: string): Promise<AxiosResponse<SandboxDto>> {
    return api.post(`/sandboxes/${id}/stop`);
  },
  destroy(id: string): Promise<AxiosResponse<void>> {
    return api.delete(`/sandboxes/${id}`);
  },
  extendTtl(id: string, additionalSeconds: number): Promise<AxiosResponse<SandboxDto>> {
    return api.post(`/sandboxes/${id}/extend-ttl`, { additionalSeconds });
  },
  readFile(id: string, path: string): Promise<AxiosResponse<string>> {
    return api.get(`/sandboxes/${id}/files`, { params: { path } });
  },
  writeFile(id: string, path: string, content: string): Promise<AxiosResponse<void>> {
    return api.post(`/sandboxes/${id}/files`, { path, content });
  },
};

// Sandbox Profiles
export const sandboxProfilesApi = {
  getAll(params?: { limit?: number; offset?: number }): Promise<AxiosResponse<PaginatedResponse<SandboxProfileDto>>> {
    return api.get('/sandbox-profiles', { params });
  },
  getOne(id: string): Promise<AxiosResponse<SandboxProfileDto>> {
    return api.get(`/sandbox-profiles/${id}`);
  },
  create(dto: CreateSandboxProfileDto): Promise<AxiosResponse<SandboxProfileDto>> {
    return api.post('/sandbox-profiles', dto);
  },
  update(id: string, dto: UpdateSandboxProfileDto): Promise<AxiosResponse<SandboxProfileDto>> {
    return api.patch(`/sandbox-profiles/${id}`, dto);
  },
  delete(id: string): Promise<AxiosResponse<void>> {
    return api.delete(`/sandbox-profiles/${id}`);
  },
};

// MCP Profiles
export const mcpProfilesApi = {
  getAvailableTools(): Promise<AxiosResponse<AvailableMcpTool[]>> {
    return api.get('/mcp-profiles/available-tools');
  },
  getAll(): Promise<AxiosResponse<McpProfileDto[]>> {
    return api.get('/mcp-profiles');
  },
  getOne(id: string): Promise<AxiosResponse<McpProfileDto>> {
    return api.get(`/mcp-profiles/${id}`);
  },
  create(dto: CreateMcpProfileDto): Promise<AxiosResponse<McpProfileDto>> {
    return api.post('/mcp-profiles', dto);
  },
  update(id: string, dto: UpdateMcpProfileDto): Promise<AxiosResponse<McpProfileDto>> {
    return api.patch(`/mcp-profiles/${id}`, dto);
  },
  delete(id: string): Promise<AxiosResponse<void>> {
    return api.delete(`/mcp-profiles/${id}`);
  },
};

// Snapshots
export const snapshotsApi = {
  getAll(params?: { limit?: number; offset?: number; sandboxId?: string }): Promise<AxiosResponse<PaginatedResponse<SnapshotDto>>> {
    return api.get('/snapshots', { params });
  },
  getOne(id: string): Promise<AxiosResponse<SnapshotDto>> {
    return api.get(`/snapshots/${id}`);
  },
  create(dto: CreateSnapshotDto): Promise<AxiosResponse<SnapshotDto>> {
    return api.post('/snapshots', dto);
  },
  restore(id: string, dto: RestoreSnapshotDto = {}): Promise<AxiosResponse<SandboxDto>> {
    return api.post(`/snapshots/${id}/restore`, dto);
  },
  delete(id: string): Promise<AxiosResponse<void>> {
    return api.delete(`/snapshots/${id}`);
  },
};

// Usage
export const usageApi = {
  get(): Promise<AxiosResponse<UsageSummary>> {
    return api.get('/usage');
  },
};

export default api;
