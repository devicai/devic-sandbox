import {
  Controller,
  Post,
  Get,
  Delete,
  Req,
  Res,
  Param,
  OnModuleInit,
  Inject,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { SandboxesService } from '../sandboxes/sandboxes.service';
import { McpProfilesService } from './profiles/mcp-profiles.service';
import { McpProfile } from '../schemas/mcp-profile.schema';
import { SandboxStatus } from '../schemas/sandbox.schema';
import { CONFIG } from '../config/config.loader';
import { ModuleConfig } from '../config/config.types';
import { MCP_TOOL_NAMES } from './available-tools';

interface ResolvedProfile {
  profile: McpProfile;
  profileId: string;
}

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  profile: ResolvedProfile | null;
  sandboxId: string | null;
  // bindingId provided by the client at initialize time, used to re-attach to
  // a sandbox across reconnects when the MCP session id is not preserved.
  bindingId: string | null;
}

@Controller('mcp')
export class McpController implements OnModuleInit {
  private readonly logger = new Logger(McpController.name);
  private enabled = false;
  private readonly sessions = new Map<string, SessionEntry>();

  constructor(
    private readonly sandboxesService: SandboxesService,
    private readonly profilesService: McpProfilesService,
    @Inject(CONFIG) private readonly config: ModuleConfig,
  ) {}

  onModuleInit() {
    if (!this.config.mcp?.enabled) {
      this.logger.warn('MCP server is disabled in configuration');
      return;
    }
    this.enabled = true;
    this.logger.log('MCP server initialized with sandbox tools');
  }

  private canUseTool(resolved: ResolvedProfile | null, toolName: string, isWrite: boolean): boolean {
    if (!resolved) return true;
    if (resolved.profile.readOnly && isWrite) return false;
    const allowed = resolved.profile.allowedTools ?? [];
    if (allowed.length === 0) return false;
    return allowed.includes(toolName);
  }

  private async createServer(
    resolved: ResolvedProfile | null,
    session: SessionEntry,
  ): Promise<McpServer> {
    const server = new McpServer({
      name: resolved
        ? `operator (${resolved.profile.name})`
        : 'operator',
      version: process.env.npm_package_version ?? '0.1.0',
    });
    this.registerTools(server, resolved, session);
    return server;
  }

  /**
   * Resolves the sandbox to use for a tool call.
   *
   * Order of precedence:
   *  1. Explicit `providedSandboxId` argument from the tool call (opt-in).
   *     Validated; if running it is also adopted as the session's sandbox so
   *     subsequent calls without an explicit id reuse it.
   *  2. Session-bound sandbox (`session.sandboxId`), set by `create_sandbox`
   *     or by a previous tool call in this session.
   *  3. Sandbox bound by `bindingId` (provided at initialize time): looked up
   *     fresh on every call so a session that reconnected with a new id can
   *     still re-attach to the previous sandbox.
   *  4. Fresh sandbox created on the spot using the session's default profile.
   */
  private async resolveSandbox(
    session: SessionEntry,
    providedSandboxId: string | undefined,
    toolName: string,
  ): Promise<string> {
    const scope = {};

    if (providedSandboxId) {
      const doc = await this.sandboxesService.findById(providedSandboxId, scope);
      if (doc.status !== SandboxStatus.RUNNING) {
        throw new Error(
          `Sandbox ${providedSandboxId} is not running (status: ${doc.status})`,
        );
      }
      if (!session.sandboxId) {
        session.sandboxId = doc.sandboxId;
        this.logger.debug(
          `[mcp:${toolName}] adopted explicit sandboxId=${doc.sandboxId} into empty session`,
        );
      } else if (session.sandboxId !== doc.sandboxId) {
        this.logger.debug(
          `[mcp:${toolName}] using explicit sandboxId=${doc.sandboxId} (session bound to ${session.sandboxId})`,
        );
      }
      return doc.sandboxId;
    }

    if (session.sandboxId) return session.sandboxId;

    if (session.bindingId) {
      const existing = await this.sandboxesService.findByBinding(
        session.bindingId,
        scope,
      );
      if (existing && existing.status === SandboxStatus.RUNNING) {
        session.sandboxId = existing.sandboxId;
        this.logger.debug(
          `[mcp:${toolName}] re-attached session to sandbox ${existing.sandboxId} via bindingId=${session.bindingId}`,
        );
        return existing.sandboxId;
      }
    }

    const profileId = session.profile?.profile.defaultSandboxProfileId;
    // Lazy-create only diverges from the hot pool snapshot when the MCP
    // profile pins a specific sandbox profile. With no profileId the default
    // image/cpus/memory line up with the snapshot, so reaching for the pool
    // is safe — fallback to fresh create is automatic if it's empty.
    const useHotPool = !profileId;
    const sandbox = await this.sandboxesService.create(
      { profileId, bindingId: session.bindingId ?? undefined, useHotPool },
      scope,
    );
    session.sandboxId = sandbox.sandboxId;
    const fromHot = (sandbox.metadata as any)?.hotPool === true;
    this.logger.debug(
      `[mcp:${toolName}] ${fromHot ? 'claimed hot' : 'created'} sandbox ${sandbox.sandboxId} on first tool call (binding=${session.bindingId ?? '-'})`,
    );
    return sandbox.sandboxId;
  }

  private registerTools(
    server: McpServer,
    resolved: ResolvedProfile | null,
    session: SessionEntry,
  ) {
    const errorResult = (msg: string) => ({
      content: [{ type: 'text' as const, text: `Error: ${msg}` }],
      isError: true,
    });

    if (this.canUseTool(resolved, 'create_sandbox', true)) {
      server.tool(
        'create_sandbox',
        'Create a new sandbox environment or reuse an existing one. Without arguments returns the session-bound sandbox if one already exists; pass `bindingId` for cross-session resolution or `force: true` to always allocate a fresh sandbox. Hot pool is used by default when no incompatible override (image/profileId) is present — pass `useHotPool: false` to skip it.',
        {
          profileId: z.string().optional().describe('Sandbox profile ID'),
          bindingId: z.string().optional().describe('External binding ID — reuses or creates a sandbox keyed by this id'),
          image: z.string().optional().describe('Docker image'),
          ttlSeconds: z.number().optional().describe('TTL in seconds'),
          force: z.boolean().optional().describe('Create a fresh sandbox even if the session already has one bound'),
          useHotPool: z
            .boolean()
            .optional()
            .describe(
              'Override hot pool resolution: true forces an attempt (falls back to fresh create), false skips it. Defaults to true unless image/profileId would diverge from the pool snapshot.',
            ),
        } as any,
        async ({ profileId, bindingId, image, ttlSeconds, force, useHotPool }: any) => {
          try {
            const scope = {};
            let sandbox;

            const noOverrides = !bindingId && !image && !ttlSeconds && !profileId;
            if (!force && noOverrides && session.sandboxId) {
              const existing = await this.sandboxesService
                .findById(session.sandboxId, scope)
                .catch(() => null);
              if (existing && existing.status === SandboxStatus.RUNNING) {
                this.logger.debug(
                  `[mcp:create_sandbox] returning session-bound sandbox ${existing.sandboxId}`,
                );
                return {
                  content: [{ type: 'text' as const, text: JSON.stringify({
                    sandboxId: existing.sandboxId,
                    status: existing.status,
                    image: existing.image,
                    workdir: existing.workdir,
                    ttlSeconds: existing.ttlSeconds,
                    expiresAt: existing.expiresAt,
                    publicUrl: existing.publicUrl,
                    reused: true,
                  }, null, 2) }],
                };
              }
            }

            const effectiveProfileId =
              profileId ?? session.profile?.profile.defaultSandboxProfileId;
            // Hot pool only when nothing in the request would diverge from the
            // snapshot (no custom image, no profile) unless the caller forces it.
            const wantsHotPool =
              useHotPool !== undefined
                ? useHotPool
                : !image && !effectiveProfileId;

            if (bindingId) {
              sandbox = await this.sandboxesService.getOrCreateByBinding(
                bindingId,
                effectiveProfileId,
                scope,
              );
            } else {
              sandbox = await this.sandboxesService.create(
                {
                  profileId: effectiveProfileId,
                  image,
                  ttlSeconds,
                  bindingId: session.bindingId ?? undefined,
                  useHotPool: wantsHotPool,
                },
                scope,
              );
            }

            session.sandboxId = sandbox.sandboxId;

            const fromHot = (sandbox.metadata as any)?.hotPool === true;
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({
                sandboxId: sandbox.sandboxId,
                status: sandbox.status,
                image: sandbox.image,
                workdir: sandbox.workdir,
                ttlSeconds: sandbox.ttlSeconds,
                expiresAt: sandbox.expiresAt,
                publicUrl: sandbox.publicUrl,
                reused: false,
                fromHotPool: fromHot,
              }, null, 2) }],
            };
          } catch (error) {
            return errorResult((error as Error).message);
          }
        },
      );
    }

    const SANDBOX_ID_DESC =
      'Optional explicit sandbox id. When provided overrides the session-bound sandbox for this single call.';

    if (this.canUseTool(resolved, 'run_command', true)) {
      server.tool(
        'run_command',
        'Execute a shell command in the active sandbox.',
        {
          command: z.string().describe('Shell command to execute'),
          cwd: z.string().optional().describe('Working directory override'),
          sandboxId: z.string().optional().describe(SANDBOX_ID_DESC),
        } as any,
        async ({ command, cwd, sandboxId }: { command: string; cwd?: string; sandboxId?: string }) => {
          try {
            const id = await this.resolveSandbox(session, sandboxId, 'run_command');
            const result = await this.sandboxesService.runCommand(
              id,
              { command, cwd },
              {},
            );
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
            };
          } catch (error) {
            return errorResult((error as Error).message);
          }
        },
      );
    }

    if (this.canUseTool(resolved, 'write_file', true)) {
      server.tool(
        'write_file',
        'Write content to a file in the sandbox.',
        {
          path: z.string().describe('File path'),
          content: z.string().describe('File content'),
          sandboxId: z.string().optional().describe(SANDBOX_ID_DESC),
        } as any,
        async ({ path, content, sandboxId }: { path: string; content: string; sandboxId?: string }) => {
          try {
            const id = await this.resolveSandbox(session, sandboxId, 'write_file');
            await this.sandboxesService.writeFile(id, path, content, {});
            return {
              content: [{ type: 'text' as const, text: `File written: ${path}` }],
            };
          } catch (error) {
            return errorResult((error as Error).message);
          }
        },
      );
    }

    if (this.canUseTool(resolved, 'create_directory', true)) {
      server.tool(
        'create_directory',
        'Create a directory in the sandbox.',
        {
          path: z.string().describe('Directory path to create'),
          sandboxId: z.string().optional().describe(SANDBOX_ID_DESC),
        } as any,
        async ({ path, sandboxId }: { path: string; sandboxId?: string }) => {
          try {
            const id = await this.resolveSandbox(session, sandboxId, 'create_directory');
            await this.sandboxesService.runCommand(
              id,
              { command: `mkdir -p '${path}'` },
              {},
            );
            return {
              content: [{ type: 'text' as const, text: `Directory created: ${path}` }],
            };
          } catch (error) {
            return errorResult((error as Error).message);
          }
        },
      );
    }

    if (this.canUseTool(resolved, 'stop_sandbox', true)) {
      server.tool(
        'stop_sandbox',
        'Stop the active sandbox. Creates a snapshot for potential restore.',
        {
          sandboxId: z.string().optional().describe(SANDBOX_ID_DESC),
        } as any,
        async ({ sandboxId }: { sandboxId?: string }) => {
          try {
            const targetId = sandboxId ?? session.sandboxId;
            if (!targetId) {
              return errorResult('No active sandbox in this session');
            }
            const result = await this.sandboxesService.stop(targetId, {});
            if (session.sandboxId === targetId) {
              session.sandboxId = null;
            }
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({
                sandboxId: result.sandboxId,
                status: result.status,
                snapshotId: result.snapshotId,
              }, null, 2) }],
            };
          } catch (error) {
            return errorResult((error as Error).message);
          }
        },
      );
    }

    if (this.canUseTool(resolved, 'extend_ttl', true)) {
      server.tool(
        'extend_ttl',
        'Extend the time to live of the active sandbox.',
        {
          additionalSeconds: z.number().describe('Additional seconds to add'),
          sandboxId: z.string().optional().describe(SANDBOX_ID_DESC),
        } as any,
        async ({ additionalSeconds, sandboxId }: { additionalSeconds: number; sandboxId?: string }) => {
          try {
            const id = await this.resolveSandbox(session, sandboxId, 'extend_ttl');
            const result = await this.sandboxesService.extendTtl(
              id,
              additionalSeconds,
              {},
            );
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({
                sandboxId: result.sandboxId,
                expiresAt: result.expiresAt,
              }, null, 2) }],
            };
          } catch (error) {
            return errorResult((error as Error).message);
          }
        },
      );
    }

    if (this.canUseTool(resolved, 'upload_file', true)) {
      server.tool(
        'upload_file',
        'Download a file from a URL and save it to the sandbox.',
        {
          url: z.string().describe('Public URL to download from'),
          path: z.string().describe('Destination path in the sandbox'),
          sandboxId: z.string().optional().describe(SANDBOX_ID_DESC),
        } as any,
        async ({ url, path, sandboxId }: { url: string; path: string; sandboxId?: string }) => {
          try {
            const id = await this.resolveSandbox(session, sandboxId, 'upload_file');
            await this.sandboxesService.runCommand(
              id,
              { command: `curl -fsSL -o '${path}' '${url}'` },
              {},
            );
            return {
              content: [{ type: 'text' as const, text: `File downloaded to: ${path}` }],
            };
          } catch (error) {
            return errorResult((error as Error).message);
          }
        },
      );
    }

    if (this.canUseTool(resolved, 'get_sandbox_status', false)) {
      server.tool(
        'get_sandbox_status',
        'Get the current status of the sandbox including remaining TTL.',
        {
          sandboxId: z.string().optional().describe(SANDBOX_ID_DESC),
        } as any,
        async ({ sandboxId }: { sandboxId?: string }) => {
          try {
            const targetId = sandboxId ?? session.sandboxId;
            if (!targetId) {
              return {
                content: [{ type: 'text' as const, text: JSON.stringify({
                  status: 'no_sandbox',
                  message: 'No sandbox attached to this session',
                }, null, 2) }],
              };
            }
            const status = await this.sandboxesService.getStatus(targetId, {});
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(status, null, 2) }],
            };
          } catch (error) {
            return errorResult((error as Error).message);
          }
        },
      );
    }

    if (this.canUseTool(resolved, 'list_files', false)) {
      server.tool(
        'list_files',
        'List files and directories in the sandbox.',
        {
          path: z.string().optional().describe('Directory path (default: current working directory)'),
          sandboxId: z.string().optional().describe(SANDBOX_ID_DESC),
        } as any,
        async ({ path, sandboxId }: { path?: string; sandboxId?: string }) => {
          try {
            const id = await this.resolveSandbox(session, sandboxId, 'list_files');
            const dir = path || '.';
            const result = await this.sandboxesService.runCommand(
              id,
              { command: `ls -la '${dir}'` },
              {},
            );
            return {
              content: [{ type: 'text' as const, text: result.stdout }],
            };
          } catch (error) {
            return errorResult((error as Error).message);
          }
        },
      );
    }

    if (this.canUseTool(resolved, 'read_file', false)) {
      server.tool(
        'read_file',
        'Read the content of a file in the sandbox.',
        {
          path: z.string().describe('File path to read'),
          sandboxId: z.string().optional().describe(SANDBOX_ID_DESC),
        } as any,
        async ({ path, sandboxId }: { path: string; sandboxId?: string }) => {
          try {
            const id = await this.resolveSandbox(session, sandboxId, 'read_file');
            const content = await this.sandboxesService.readFile(
              id,
              path,
              {},
            );
            return {
              content: [{ type: 'text' as const, text: content }],
            };
          } catch (error) {
            return errorResult((error as Error).message);
          }
        },
      );
    }

    if (this.canUseTool(resolved, 'download_file', false)) {
      server.tool(
        'download_file',
        'Get the content of a file from the sandbox encoded in base64.',
        {
          path: z.string().describe('File path to download'),
          sandboxId: z.string().optional().describe(SANDBOX_ID_DESC),
        } as any,
        async ({ path, sandboxId }: { path: string; sandboxId?: string }) => {
          try {
            const id = await this.resolveSandbox(session, sandboxId, 'download_file');
            const content = await this.sandboxesService.readFile(
              id,
              path,
              {},
            );
            const base64 = Buffer.from(content).toString('base64');
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({
                path,
                encoding: 'base64',
                data: base64,
                sizeBytes: Buffer.byteLength(content),
              }, null, 2) }],
            };
          } catch (error) {
            return errorResult((error as Error).message);
          }
        },
      );
    }

    void MCP_TOOL_NAMES;
  }

  // HTTP entrypoints
  @Post()
  handlePostRoot(@Req() req: Request, @Res() res: Response) {
    return this.handlePost(req, res, undefined);
  }

  @Post(':profileId')
  handlePostProfile(
    @Param('profileId') profileId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.handlePost(req, res, profileId);
  }

  @Get()
  handleGetRoot(@Req() req: Request, @Res() res: Response) {
    return this.handleGet(req, res);
  }

  @Get(':profileId')
  handleGetProfile(@Req() req: Request, @Res() res: Response) {
    return this.handleGet(req, res);
  }

  @Delete()
  handleDeleteRoot(@Req() req: Request, @Res() res: Response) {
    return this.handleDelete(req, res);
  }

  @Delete(':profileId')
  handleDeleteProfile(@Req() req: Request, @Res() res: Response) {
    return this.handleDelete(req, res);
  }

  private async handlePost(
    req: Request,
    res: Response,
    profileId: string | undefined,
  ) {
    if (!this.enabled) {
      res.status(503).json({ error: 'MCP server is not enabled' });
      return;
    }

    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const bindingHeader =
      (req.headers['mcp-binding-id'] as string | undefined) ??
      (req.headers['x-mcp-binding-id'] as string | undefined);
    let transport: StreamableHTTPServerTransport | undefined;

    try {
      if (sessionId && this.sessions.has(sessionId)) {
        transport = this.sessions.get(sessionId)!.transport;
      } else if (!sessionId && isInitializeRequest(req.body)) {
        let resolved: ResolvedProfile | null = null;
        if (profileId) {
          const profile = await this.profilesService.resolveProfile(profileId);
          if (!profile) {
            res.status(404).json({
              jsonrpc: '2.0',
              error: { code: -32000, message: `MCP profile ${profileId} not found` },
              id: null,
            });
            return;
          }
          resolved = {
            profile,
            profileId: (profile as any)._id.toString(),
          };
        }

        const sessionEntry: SessionEntry = {
          transport: null as any,
          profile: resolved,
          sandboxId: null,
          bindingId: bindingHeader ?? null,
        };

        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            this.logger.log(
              `MCP session initialized: ${sid}` +
                (resolved ? ` (profile: ${resolved.profile.name})` : '') +
                (bindingHeader ? ` (bindingId: ${bindingHeader})` : ''),
            );
            sessionEntry.transport = transport!;
            this.sessions.set(sid, sessionEntry);
          },
        });

        transport.onclose = () => {
          if (transport!.sessionId) {
            this.logger.log(`MCP session closed: ${transport!.sessionId}`);
            this.sessions.delete(transport!.sessionId);
          }
        };

        const server = await this.createServer(resolved, sessionEntry);
        await server.connect(transport);
      } else {
        res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Bad Request: No valid session ID provided',
          },
          id: null,
        });
        return;
      }

      await transport!.handleRequest(req, res, req.body);
    } catch (error) {
      this.logger.error(`MCP POST error: ${(error as Error).message}`, (error as Error).stack);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal MCP server error' });
      }
    }
  }

  private async handleGet(req: Request, res: Response) {
    if (!this.enabled) {
      res.status(503).json({ error: 'MCP server is not enabled' });
      return;
    }

    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !this.sessions.has(sessionId)) {
      res.status(400).send('Invalid or missing session ID');
      return;
    }

    try {
      await this.sessions.get(sessionId)!.transport.handleRequest(req, res);
    } catch (error) {
      this.logger.error(`MCP GET error: ${(error as Error).message}`, (error as Error).stack);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal MCP server error' });
      }
    }
  }

  private async handleDelete(req: Request, res: Response) {
    if (!this.enabled) {
      res.status(503).json({ error: 'MCP server is not enabled' });
      return;
    }

    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !this.sessions.has(sessionId)) {
      res.status(400).send('Invalid or missing session ID');
      return;
    }

    try {
      await this.sessions.get(sessionId)!.transport.handleRequest(req, res);
    } catch (error) {
      this.logger.error(`MCP DELETE error: ${(error as Error).message}`, (error as Error).stack);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal MCP server error' });
      }
    }
  }
}
