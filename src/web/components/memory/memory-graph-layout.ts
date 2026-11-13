import type { MemoryGraphData } from "./memory-graph-model";

const GOLDEN_ANGLE = 2.399963229728653;

/** 有界的确定性力布局：只在数据或视角变化时计算，没有定时器或持续渲染。 */
export function layoutMemoryGraph(graph: MemoryGraphData) {
  const linked = graph.nodes.filter((node) => node.degree > 0);
  const isolated = graph.nodes.filter((node) => !node.degree);
  const indexById = new Map(linked.map((node, index) => [node.id, index]));
  const edges = graph.edges.map((edge) => ({
    source: indexById.get(edge.source.id)!,
    target: indexById.get(edge.target.id)!,
    strength: Math.min(0.065, edge.strength * 0.018),
    length: 38 + Math.abs(edge.bend) * 100,
  }));
  const velocity = linked.map(() => ({ x: 0, y: 0 }));
  for (const [index, node] of linked.entries()) {
    const angle = index * GOLDEN_ANGLE;
    const radius = 185 * Math.sqrt((index + 0.5) / linked.length);
    node.x = Math.cos(angle) * radius;
    node.y = Math.sin(angle) * radius;
  }
  for (let step = 0; step < 150; step++) {
    const force = linked.map((node) => ({
      x: -node.x * 0.002,
      y: -node.y * 0.002,
    }));
    for (let a = 0; a < linked.length; a++) {
      for (let b = a + 1; b < linked.length; b++) {
        const dx = linked[a].x - linked[b].x;
        const dy = linked[a].y - linked[b].y;
        const distance = Math.max(25, dx * dx + dy * dy);
        const repel = 170 / distance;
        force[a].x += dx * repel;
        force[a].y += dy * repel;
        force[b].x -= dx * repel;
        force[b].y -= dy * repel;
      }
    }
    for (const edge of edges) {
      const dx = linked[edge.target].x - linked[edge.source].x;
      const dy = linked[edge.target].y - linked[edge.source].y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const pull = ((distance - edge.length) / distance) * edge.strength;
      force[edge.source].x += dx * pull;
      force[edge.source].y += dy * pull;
      force[edge.target].x -= dx * pull;
      force[edge.target].y -= dy * pull;
    }
    const cooling = 1 - step / 190;
    for (const [index, node] of linked.entries()) {
      const speed = velocity[index];
      speed.x = (speed.x + force[index].x) * 0.52;
      speed.y = (speed.y + force[index].y) * 0.52;
      node.x += Math.max(-7, Math.min(7, speed.x)) * cooling;
      node.y += Math.max(-7, Math.min(7, speed.y)) * cooling;
    }
  }
  if (linked.length) {
    const centerX =
      linked.reduce((sum, node) => sum + node.x, 0) / linked.length;
    const centerY =
      linked.reduce((sum, node) => sum + node.y, 0) / linked.length;
    const extent = Math.max(
      1,
      ...linked.map((node) => Math.hypot(node.x - centerX, node.y - centerY))
    );
    const radius = Math.min(235, 110 + Math.sqrt(linked.length) * 10);
    for (const node of linked) {
      node.x = ((node.x - centerX) / extent) * radius;
      node.y = ((node.y - centerY) / extent) * radius;
    }
  }
  // 孤立记忆占据外围的疏密有序环带；每一点都对应一条真实记录。
  const outerRadius = linked.length
    ? 270
    : Math.min(260, 130 + Math.sqrt(isolated.length) * 10);
  let remaining = isolated.length;
  let offset = 0;
  let ring = 0;
  while (remaining > 0) {
    const radius = Math.max(60, outerRadius - ring * 28);
    const capacity = Math.max(8, Math.floor((2 * Math.PI * radius) / 23));
    const count = Math.min(remaining, capacity);
    for (let index = 0; index < count; index++) {
      const node = isolated[offset + index];
      const angle =
        (index / count) * Math.PI * 2 +
        ring * GOLDEN_ANGLE +
        0.16 * Math.sin(index * 1.7);
      const distance =
        isolated.length === 1 && !linked.length
          ? 0
          : radius + 6 * Math.sin(index * 2.1 + ring);
      node.x = Math.cos(angle) * distance;
      node.y = Math.sin(angle) * distance;
    }
    offset += count;
    remaining -= count;
    ring++;
  }
}
