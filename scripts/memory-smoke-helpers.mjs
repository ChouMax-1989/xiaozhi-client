import assert from "node:assert/strict";
import { createHash } from "node:crypto";

// 按模型拿到的同一协议续读；同时验证帧预算、连续性、重复读取和完整性。
export async function readMemoryResult(readNext, response) {
  function decode(result) {
    assert.notEqual(result.isError, true, "工具应成功返回");
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 1024, "工具结果须在1024字节预算内");
    const text = result.content.find((item) => item.type === "text");
    assert.ok(text);
    return JSON.parse(text.text);
  }
  let piece = decode(response);
  if (!piece.segmented) return piece;
  const { cursor, totalLength, sha256 } = piece;
  assert.equal(piece.offset, 0);
  assert.equal(typeof cursor, "string");
  assert.equal(typeof sha256, "string");
  const replay = decode(await readNext({ cursor, offset: 0 }));
  assert.deepEqual(replay, piece, "同一片段重读必须一致");
  let text = "";
  let pages = 0;
  while (true) {
    assert.equal(piece.segmented, true);
    assert.equal(piece.cursor, cursor);
    assert.equal(piece.sha256, sha256);
    assert.equal(piece.totalLength, totalLength);
    assert.equal(piece.offset, text.length, "片段不能重复或跳过");
    assert.ok(piece.chunk.length > 0);
    assert.ok(!/[\uD800-\uDBFF]$/u.test(piece.chunk), "片段不能拆开表情代理对");
    text += piece.chunk;
    assert.ok(++pages < 10_000, "续读必须前进并结束");
    if (piece.nextOffset === null) break;
    assert.equal(piece.nextOffset, text.length);
    piece = decode(await readNext({ cursor, offset: piece.nextOffset }));
  }
  assert.equal(text.length, totalLength);
  assert.equal(createHash("sha256").update(text, "utf8").digest("hex"), sha256);
  return JSON.parse(text);
}
