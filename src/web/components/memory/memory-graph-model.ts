import { memoryApi } from "@/services/memoryApi";
import type { MemoryRecord } from "../../../types/memory-admin";

export const GRAPH_LIMIT = 200;
export type GraphRelation = "facet" | "subject" | "source";
export const relationLabels: Record<GraphRelation, string> = {
  facet: "相同分类",
  subject: "相同主体标记",
  source: "相同来源消息",
};

export interface GraphNode {
  id: string;
  label: string;
  memory?: MemoryRecord;
  members: string[];
  color: number;
  x: number;
  y: number;
}

export interface MemoryGraphData {
  nodes: GraphNode[];
  edges: { id: string; source: GraphNode; target: GraphNode }[];
  isolated: number;
}

/** 按服务端顺序读取有限集合，沿用已有分页和取消信号。 */
export async function loadGraphMemories(signal: AbortSignal) {
  const input = { status: "current" as const, pageSize: 50 };
  const first = await memoryApi.entries({ ...input, page: 1 }, signal);
  signal.throwIfAborted();
  const pages = Math.min(Math.ceil(first.total / 50), GRAPH_LIMIT / 50);
  const rest = await Promise.all(
    Array.from({ length: Math.max(0, pages - 1) }, (_, index) =>
      memoryApi.entries({ ...input, page: index + 2 }, signal)
    )
  );
  signal.throwIfAborted();
  const unique = new Map<string, MemoryRecord>();
  for (const page of [first, ...rest]) {
    for (const memory of page.items) unique.set(memory.id, memory);
  }
  return {
    items: [...unique.values()].slice(0, GRAPH_LIMIT),
    total: first.total,
  };
}

function colorIndex(value: string) {
  let hash = 0;
  for (const character of value)
    hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return (Math.abs(hash) % 5) + 1;
}

function memberships(memory: MemoryRecord, relation: GraphRelation) {
  if (relation === "facet") {
    return memory.facet ? [{ key: memory.facet, label: memory.facet }] : [];
  }
  if (relation === "source") {
    return [
      ...new Map(
        memory.sources
          .filter((source) => source.messageId)
          .map((source) => [
            JSON.stringify([memory.scope, source.messageId, source.revision]),
            {
              key: JSON.stringify([
                memory.scope,
                source.messageId,
                source.revision,
              ]),
              label: `来源消息 · ${source.messageId} · 版本 ${source.revision}`,
            },
          ])
      ).values(),
    ];
  }
  const { kind, label } = memory.subject;
  // 未命名的相关人物或事物并不能证明是同一个主体。
  if (kind !== "speaker" && !label) return [];
  const kindLabel = {
    speaker: "本人",
    related_person: "相关人物",
    entity: "事物",
  }[kind];
  return [
    {
      key: JSON.stringify([memory.scope, kind, label ?? ""]),
      label: label ? `${kindLabel} · ${label}` : kindLabel,
    },
  ];
}

/** 线只表达已存字段的共同归属，不推断语义或人物关系。 */
export function buildMemoryGraph(
  memories: MemoryRecord[],
  relation: GraphRelation
): MemoryGraphData {
  const records = [
    ...new Map(memories.map((memory) => [memory.id, memory])).values(),
  ].sort((a, b) => a.id.localeCompare(b.id));
  const nodes: GraphNode[] = records.map((memory, index) => {
    const angle = index * 2.399963;
    const radius = 160 * Math.sqrt((index + 0.5) / Math.max(1, records.length));
    return {
      id: `memory:${memory.id}`,
      label: `${memory.facet}：${memory.value}`,
      memory,
      members: [memory.id],
      color: colorIndex(memory.facet),
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
    };
  });
  const groups = new Map<string, { label: string; nodes: GraphNode[] }>();
  for (const node of nodes) {
    for (const membership of memberships(node.memory!, relation)) {
      const group = groups.get(membership.key) ?? {
        label: membership.label,
        nodes: [],
      };
      group.nodes.push(node);
      groups.set(membership.key, group);
    }
  }
  const shared = [...groups.entries()].filter(
    ([, group]) => group.nodes.length > 1
  );
  const connected = new Set(shared.flatMap(([, group]) => group.nodes));
  const linkedNodes = nodes.filter((node) => connected.has(node));
  const isolatedNodes = nodes.filter((node) => !connected.has(node));

  // 仅对最多 200 个记忆点做确定性布局；关联节点取成员重心，不运行持续动画。
  for (let step = 0; step < 65; step++) {
    const forces = new Map(
      linkedNodes.map((node) => [
        node,
        { x: -node.x * 0.008, y: -node.y * 0.008 },
      ])
    );
    for (let a = 0; a < linkedNodes.length; a++) {
      for (let b = a + 1; b < linkedNodes.length; b++) {
        const left = linkedNodes[a];
        const right = linkedNodes[b];
        const dx = left.x - right.x;
        const dy = left.y - right.y;
        const distance = Math.max(16, dx * dx + dy * dy);
        const force = 35 / distance;
        forces.get(left)!.x += dx * force;
        forces.get(left)!.y += dy * force;
        forces.get(right)!.x -= dx * force;
        forces.get(right)!.y -= dy * force;
      }
    }
    for (const [, group] of shared) {
      const x =
        group.nodes.reduce((sum, node) => sum + node.x, 0) / group.nodes.length;
      const y =
        group.nodes.reduce((sum, node) => sum + node.y, 0) / group.nodes.length;
      for (const node of group.nodes) {
        const force = forces.get(node)!;
        force.x += (x - node.x) * 0.015;
        force.y += (y - node.y) * 0.015;
      }
    }
    for (const node of linkedNodes) {
      const force = forces.get(node)!;
      node.x += Math.max(-5, Math.min(5, force.x));
      node.y += Math.max(-5, Math.min(5, force.y));
    }
  }
  const extent = Math.max(
    1,
    ...linkedNodes.map((node) => Math.hypot(node.x, node.y))
  );
  for (const node of linkedNodes) {
    node.x = (node.x / extent) * 170;
    node.y = (node.y / extent) * 170;
  }
  for (const [index, node] of isolatedNodes.entries()) {
    const angle = index * 2.399963;
    const radius = connected.size
      ? 200 + 40 * Math.sqrt((index + 0.5) / isolatedNodes.length)
      : isolatedNodes.length === 1
        ? 0
        : 210 * Math.sqrt((index + 0.5) / isolatedNodes.length);
    node.x = Math.cos(angle) * radius;
    node.y = Math.sin(angle) * radius;
  }
  const edges: MemoryGraphData["edges"] = [];
  for (const [key, group] of shared) {
    const hub: GraphNode = {
      id: `group:${relation}:${key}`,
      label: `${group.label} · ${group.nodes.length} 条记忆`,
      members: group.nodes.map((node) => node.memory!.id),
      color: colorIndex(group.label),
      x:
        group.nodes.reduce((sum, node) => sum + node.x, 0) / group.nodes.length,
      y:
        group.nodes.reduce((sum, node) => sum + node.y, 0) / group.nodes.length,
    };
    // 多个来源可能拥有完全相同的成员，轻微错开共同字段点以便逐一选中。
    const center = { x: hub.x, y: hub.y };
    for (let attempt = 1; attempt <= 64; attempt++) {
      if (
        nodes.every((node) => Math.hypot(node.x - hub.x, node.y - hub.y) >= 18)
      )
        break;
      const radius = 18 * Math.sqrt(attempt);
      hub.x = center.x + Math.cos(attempt * 2.399963) * radius;
      hub.y = center.y + Math.sin(attempt * 2.399963) * radius;
    }
    nodes.push(hub);
    for (const node of group.nodes)
      edges.push({ id: `${hub.id}:${node.id}`, source: hub, target: node });
  }
  const bounds = Math.max(
    240,
    ...nodes.map((node) => Math.max(Math.abs(node.x), Math.abs(node.y)))
  );
  if (bounds > 240) {
    for (const node of nodes) {
      node.x *= 240 / bounds;
      node.y *= 240 / bounds;
    }
  }
  return { nodes, edges, isolated: isolatedNodes.length };
}
