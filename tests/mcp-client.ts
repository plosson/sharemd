import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';

const PROJECT_ROOT = join(import.meta.dir, '..');

/** A scripted MCP client — what a real agent's MCP host would run. */
export class AgentClient {
  private constructor(
    readonly name: string,
    private readonly client: Client,
  ) {}

  static async spawn(
    serverUrl: string,
    name: string,
    launch?: { command: string; args: string[] },
  ): Promise<AgentClient> {
    const transport = new StdioClientTransport({
      command: launch?.command ?? process.execPath,
      args: launch?.args ?? ['run', join(PROJECT_ROOT, 'src', 'mcp', 'index.ts')],
      env: {
        ...getDefaultEnvironment(),
        SHAREMD_SERVER: serverUrl,
        SHAREMD_USERNAME: name,
      },
      stderr: 'pipe',
    });
    const client = new Client({ name: `test-host-${name}`, version: '0.0.1' });
    await client.connect(transport);
    return new AgentClient(name, client);
  }

  async call<T = Record<string, unknown>>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
    const result = await this.client.callTool({ name: tool, arguments: args });
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
    if (result.isError) {
      throw new Error(`${tool} failed: ${text}`);
    }
    return JSON.parse(text) as T;
  }

  async callExpectingError(tool: string, args: Record<string, unknown> = {}): Promise<string> {
    const result = await this.client.callTool({ name: tool, arguments: args });
    if (!result.isError) {
      throw new Error(`${tool} unexpectedly succeeded`);
    }
    return (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
  }

  async listTools(): Promise<string[]> {
    const { tools } = await this.client.listTools();
    return tools.map((tool) => tool.name).sort();
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
