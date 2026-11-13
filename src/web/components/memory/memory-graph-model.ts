import { memoryApi } from "@/services/memoryApi";
import type { MemoryRecord } from "../../../types/memory-admin";
import { layoutMemoryGraph } from "./memory-graph-layout";

export const GRAPH_LIMIT = 200;
export type GraphRelationKind = "facet" | "subject" | "source";
export type GraphRelation = "all" | GraphRelationKind;
export const relationLabels: Record<GraphRelation, string> = {
  all: "综合视角",
  facet: "相同分类",
  subject: "相同主体标记",
  source: "相同来源消息",
};

export interface GraphNode {
  id: string;
  label: string;
  memory: MemoryRecord;
  color: number;
  degree: number;
  x: number;
  y: number;
}
export interface GraphEvidence {
  kind: GraphRelationKind;
  key: string;
  label: string;
}
export interface GraphEdge {
  id: string;
  source: GraphNode;
  target: GraphNode;
  evidence: GraphEvidence[];
  strength: number;
  bend: number;
}
export interface MemoryGraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
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

export function graphSeed(value: string) {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}

function memberships(
  memory: MemoryRecord,
  kind: GraphRelationKind
): GraphEvidence[] {
  if (kind === "facet") {
    return memory.facet
      ? [{ kind, key: memory.facet, label: `分类 · ${memory.facet}` }]
      : [];
  }
  if (kind === "source") {
    return [
      ...new Map(
        memory.sources
          .filter((source) => source.messageId)
          .map((source) => {
            const key = JSON.stringify([
              memory.scope,
              source.messageId,
              source.revision,
            ]);
            return [
              key,
              {
                kind,
                key,
                label: `来源 · ${source.messageId} · 版本 ${source.revision}`,
              },
            ];
          })
      ).values(),
    ];
  }
  const { kind: subjectKind, label } = memory.subject;
  // 未命名的相关人物或事物并不能证明是同一个主体。
  if (subjectKind !== "speaker" && !label) return [];
  const kindLabel = {
    speaker: "本人",
    related_person: "相关人物",
    entity: "事物",
  }[subjectKind];
  return [
    {
      kind,
      key: JSON.stringify([memory.scope, subjectKind, label ?? ""]),
      label: label
        ? `主体标记 · ${kindLabel} · ${label}`
        : `主体标记 · ${kindLabel}`,
    },
  ];
}

/** 只投影真实共同字段；一条边合并全部依据，不把共同归属描述为事实因果。 */
export function buildMemoryGraph(
  memories: MemoryRecord[],
  relation: GraphRelation
): MemoryGraphData {
  const records = [
    ...new Map(memories.map((memory) => [memory.id, memory])).values(),
  ].sort((a, b) => a.id.localeCompare(b.id));
  const nodes: GraphNode[] = records.map((memory) => ({
    id: `memory:${memory.id}`,
    label: `${memory.facet}：${memory.value}`,
    memory,
    color: Math.floor(graphSeed(memory.facet) * 5) % 5,
    degree: 0,
    x: 0,
    y: 0,
  }));
  const kinds: GraphRelationKind[] =
    relation === "all" ? ["facet", "subject", "source"] : [relation];
  const groups = new Map<
    string,
    { evidence: GraphEvidence; nodes: GraphNode[] }
  >();
  for (const node of nodes) {
    for (const kind of kinds) {
      for (const evidence of memberships(node.memory, kind)) {
        const key = JSON.stringify([kind, evidence.key]);
        const group = groups.get(key) ?? { evidence, nodes: [] };
        group.nodes.push(node);
        groups.set(key, group);
      }
    }
  }
  const edgesByPair = new Map<string, GraphEdge>();
  const importance = { facet: 0.16, subject: 0.7, source: 2.5 };
  for (const { evidence, nodes: members } of groups.values()) {
    if (members.length < 2) continue;
    const strength = importance[evidence.kind] / Math.sqrt(members.length - 1);
    for (let a = 0; a < members.length; a++) {
      for (let b = a + 1; b < members.length; b++) {
        const source = members[a];
        const target = members[b];
        const id = JSON.stringify([source.id, target.id]);
        const edge = edgesByPair.get(id) ?? {
          id,
          source,
          target,
          evidence: [],
          strength: 0,
          bend: (graphSeed(id) - 0.5) * 0.22,
        };
        edge.evidence.push(evidence);
        edge.strength += strength;
        edgesByPair.set(id, edge);
      }
    }
  }
  const edges = [...edgesByPair.values()].sort((a, b) =>
    a.id.localeCompare(b.id)
  );
  for (const edge of edges) {
    edge.source.degree++;
    edge.target.degree++;
  }
  const graph = {
    nodes,
    edges,
    isolated: nodes.filter((node) => !node.degree).length,
  };
  layoutMemoryGraph(graph);
  return graph;
}
