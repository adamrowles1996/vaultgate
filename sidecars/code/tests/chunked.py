"""Files longer than one chunk, whose syntax-tree chunks differ from line chunks.

`semble` aims at chunks of 750 characters. The fixture repository's files are all shorter, so
each is one chunk however it is split, and a sidecar that chunked by lines answered them exactly
as `semble` does. These are longer: `TREE_SITTER` holds the (start, end) lines of each file's
chunks as `semble` cuts them along the file's tree-sitter syntax tree (measured with `semble`
0.6.1 and `semble-grammars` 0.1.2 in an ordinary environment); cut by lines they differ.
"""

from __future__ import annotations

PLAN = '''"""Deploys: a plan of steps, run in order, each checked before the next."""

from dataclasses import dataclass, field


@dataclass
class Step:
    """One step of a deployment: a name, a command and whether it may be retried."""

    name: str
    command: list[str]
    retries: int = 0
    notes: list[str] = field(default_factory=list)


def plan_deployment(release: str, hosts: list[str], canary: bool = True) -> list[Step]:
    """Order the steps of a release: the canary host first, then every other host."""
    ordered = sorted(hosts)
    if canary and ordered:
        ordered = [ordered[0], *ordered[1:]]
    steps = [Step("fetch", ["fetch", release])]
    for host in ordered:
        steps.append(Step(f"stop {host}", ["systemctl", "stop", "app"], retries=1))
        steps.append(Step(f"install {host}", ["install", release, host], retries=2))
        steps.append(Step(f"start {host}", ["systemctl", "start", "app"], retries=1))
    return steps


def run_deployment(steps: list[Step], execute: object) -> dict[str, int]:
    """Run each step in order, retrying as allowed, and count attempts per step."""
    attempts: dict[str, int] = {}
    for step in steps:
        for attempt in range(step.retries + 1):
            attempts[step.name] = attempt + 1
            if callable(execute) and execute(step.command):
                break
        else:
            raise RuntimeError(f"step {step.name} failed after {step.retries + 1} attempts")
    return attempts
'''

SERVER = """import { createServer, IncomingMessage, ServerResponse } from 'node:http';

export interface Route {
  method: string;
  path: string;
  handle: (request: IncomingMessage, response: ServerResponse) => void;
}

export function matchRoute(routes: Route[], method: string, path: string): Route | undefined {
  return routes.find((route) => route.method === method && route.path === path);
}

export function notFound(response: ServerResponse): void {
  response.statusCode = 404;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ error: 'not_found' }));
}

export function startServer(routes: Route[], port: number): void {
  const server = createServer((request, response) => {
    const route = matchRoute(routes, request.method ?? 'GET', request.url ?? '/');
    if (route === undefined) {
      notFound(response);
      return;
    }
    route.handle(request, response);
  });
  server.listen(port, '127.0.0.1');
}

export function healthRoute(): Route {
  return {
    method: 'GET',
    path: '/health',
    handle: (_request, response) => {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ status: 'ok' }));
    },
  };
}
"""

DEPLOYING = """# Deploying

A release is deployed host by host. The canary host goes first, and every other host follows
only once the canary answers its health check. Each step may be retried a fixed number of times.

## Planning

The plan lists every step in order: fetch the release once, then stop, install and start the
application on each host. A step that installs a release is retried twice, and the others once,
because an install can fail on a busy disk while a stop or a start rarely fails twice.

## Running

Each step runs in order. A step that still fails after its retries stops the deployment, and
the hosts not yet reached keep the previous release. Nothing is rolled back automatically: the
operator decides whether to retry the release or to deploy the previous one again.

## Health

The server answers `GET /health` with `{"status": "ok"}` once it is listening. Any other path
answers `404` with `{"error": "not_found"}`.
"""

FILES: dict[str, bytes] = {
    "src/deploy/plan.py": PLAN.encode(),
    "src/web/server.ts": SERVER.encode(),
    "docs/deploying.md": DEPLOYING.encode(),
}

TREE_SITTER: dict[str, list[tuple[int, int]]] = {
    "src/deploy/plan.py": [(1, 13), (16, 26), (29, 39)],
    "src/web/server.ts": [(1, 17), (19, 40)],
    "docs/deploying.md": [(1, 11), (12, 21)],
}
