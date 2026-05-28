// ERC-8021 Attribution - 正式仕様準拠
// フォーマット: TX_DATA + [CODE_HEX] + [SCHEMA_ID(1byte)] + [ERC_MARKER(16bytes)]

const BUILDER_CODE = "bc_dw8n1qvm";

// 16バイトのERCマーカー（固定値）
const ERC_MARKER = "ef920001000000000000000000000000";

export function addERC8021Attribution(existingData) {
  // ビルダーコードをhexに変換
  const codeBytes = Array.from(new TextEncoder().encode(BUILDER_CODE))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");

  // コード長（1バイト）
  const codeLen = (BUILDER_CODE.length).toString(16).padStart(2, "0");

  // Schema 0: [code_count=01][code_len][code_hex]
  const schemaData = "01" + codeLen + codeBytes;

  // Schema ID (0x00 = Builder Codes schema)
  const schemaId = "00";

  // サフィックス = schemaData + schemaId + ERC_MARKER
  const suffix = schemaData + schemaId + ERC_MARKER;

  const base = existingData.startsWith("0x") ? existingData.slice(2) : existingData;
  return "0x" + base + suffix;
}
