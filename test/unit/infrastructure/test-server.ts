import {
  type IncomingMessage,
  type Server,
  type ServerResponse,
  createServer,
} from "node:http";
import type { AddressInfo } from "node:net";

export type Handler = (
  request: IncomingMessage,
  response: ServerResponse,
  body: string
) => void;

export interface TestServer {
  readonly url: string;
  readonly requests: {
    method: string;
    url: string;
    body: string;
    headers: IncomingMessage["headers"];
  }[];
  close(): Promise<void>;
}

export const startServer = async (handler: Handler): Promise<TestServer> => {
  const requests: TestServer["requests"] = [];
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf-8");
    });
    request.on("end", () => {
      requests.push({
        body,
        headers: request.headers,
        method: request.method ?? "",
        url: request.url ?? "",
      });
      handler(request, response, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    close: async () => {
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      });
    },
    requests,
    url: `http://127.0.0.1:${port}/`,
  };
};

export const sendJson = (
  response: ServerResponse,
  value: unknown,
  status = 200
): void => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
};
