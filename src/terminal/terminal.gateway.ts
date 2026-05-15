import {
  WebSocketGateway,
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketServer,
} from '@nestjs/websockets';
import { Inject, Logger } from '@nestjs/common';
import { Server, WebSocket } from 'ws';
import { SandboxRegistry } from '../sandboxes/sandbox-registry';
import {
  RUNTIME_PROVIDER,
  RuntimeProvider,
  ShellSession,
} from '../runtime/runtime-provider.interface';

interface ClientSession {
  sandboxId: string;
  shell: ShellSession;
  alive: boolean;
}

@WebSocketGateway({ path: '/ws/terminal' })
export class TerminalGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(TerminalGateway.name);
  private readonly sessions = new Map<WebSocket, ClientSession>();

  @WebSocketServer()
  server: Server;

  constructor(
    private readonly registry: SandboxRegistry,
    @Inject(RUNTIME_PROVIDER) private readonly runtime: RuntimeProvider,
  ) {}

  handleConnection(client: WebSocket) {
    this.logger.log('Terminal client connected');

    client.on('message', async (raw: Buffer | string) => {
      try {
        const msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString());

        if (msg.type === 'attach' && msg.sandboxId) {
          await this.attachToSandbox(client, msg.sandboxId);
        } else if (msg.type === 'command' && msg.command) {
          await this.executeCommand(client, msg.command);
        }
      } catch (err) {
        this.send(client, {
          type: 'error',
          data: `Error: ${(err as Error).message}`,
        });
      }
    });
  }

  handleDisconnect(client: WebSocket) {
    const session = this.sessions.get(client);
    if (session) {
      session.alive = false;
      // Intentionally NOT closing the shell here: it's shared across all
      // consumers of this sandbox (terminal reconnects + agent exec calls)
      // and tearing it down on every WebSocket close would forfeit the
      // persistence guarantees (cwd, exports, shell state) we just bought.
      // The shell is reclaimed when the sandbox is stopped or removed.
      this.sessions.delete(client);
      this.logger.log(`Terminal client disconnected (sandbox: ${session.sandboxId})`);
    }
  }

  private async attachToSandbox(client: WebSocket, sandboxId: string): Promise<void> {
    const containerName = await this.registry.get(sandboxId);
    if (!containerName) {
      this.send(client, { type: 'error', data: 'Sandbox not found or not running' });
      return;
    }

    const handle = await this.runtime.get(containerName);
    if (!handle || handle.status !== 'running') {
      this.send(client, { type: 'error', data: 'Sandbox is not running' });
      return;
    }

    let shell: ShellSession;
    try {
      const sandbox = await handle.connect();
      shell = await sandbox.openShell();
    } catch (err) {
      this.send(client, {
        type: 'error',
        data: `Failed to open shell: ${(err as Error).message}`,
      });
      return;
    }

    this.sessions.set(client, {
      sandboxId,
      shell,
      alive: true,
    });

    this.send(client, {
      type: 'attached',
      data: `Connected to sandbox ${sandboxId}\r\n`,
    });
  }

  private async executeCommand(client: WebSocket, command: string): Promise<void> {
    const session = this.sessions.get(client);
    if (!session?.alive) {
      this.send(client, { type: 'error', data: 'Not attached to any sandbox' });
      return;
    }

    if (session.shell.closed) {
      this.send(client, {
        type: 'error',
        data: 'Shell session ended. Re-attach to start a new one.',
      });
      this.sessions.delete(client);
      return;
    }

    try {
      const stream = await session.shell.runStream(command);

      try {
        for await (const event of stream.events) {
          if (!session.alive) break;
          this.send(client, {
            type: event.type,
            data: event.data.toString('utf-8'),
          });
        }
        await stream.done;
      } catch (err) {
        this.send(client, {
          type: 'error',
          data: `Command error: ${(err as Error).message}`,
        });
        return;
      }

      this.send(client, { type: 'done' });
    } catch (err) {
      this.send(client, {
        type: 'error',
        data: `Command error: ${(err as Error).message}`,
      });
    }
  }

  private send(client: WebSocket, data: any): void {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  }
}
