// ERC-8021 Attribution
// npm install ox@latest してから使用

const BUILDER_CODE = "bc_dw8n1qvm";

/**
 * oxライブラリが使える環境用（Viteプロジェクト）
 */
export async function addERC8021AttributionWithOx(existingData) {
  try {
    const { Attribution } = await import("ox/erc8021");
    const suffix = Attribution.toDataSuffix({ codes: [BUILDER_CODE] });
    const base = existingData.startsWith("0x") ? existingData.slice(2) : existingData;
    const suffixHex = suffix.startsWith("0x") ? suffix.slice(2) : suffix;
    return "0x" + base + suffixHex;
  } catch (e) {
    // oxが使えない場合はフォールバック
    console.warn("ox not available, using fallback attribution");
    return addERC8021AttributionFallback(existingData);
  }
}

/**
 * フォールバック実装（oxなしでも動く）
 */
export function addERC8021AttributionFallback(existingData) {
  const codeHex = Array.from(new TextEncoder().encode(BUILDER_CODE))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
  const suffix = "ef" + "01" + codeHex.padEnd(64, "0");
  const base = existingData.startsWith("0x") ? existingData.slice(2) : existingData;
  return "0x" + base + suffix;
}

// デフォルトエクスポート（oxを優先、失敗時フォールバック）
export async function addERC8021Attribution(existingData) {
  return addERC8021AttributionWithOx(existingData);
}
