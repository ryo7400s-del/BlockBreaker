// ERC-8021 Attribution - Schema 0 (canonical registry)
// Format: txData || codes || codesLength(1) || schemaId(0) || ercMarker(16)

const ERC_MARKER = "80218021802180218021802180218021"; // 16 bytes
const SCHEMA_ID = "00"; // Schema 0
const BUILDER_CODE = "bc_dw8n1qvm"; // あなたのビルダーコード

export function getDataSuffix() {
  // Encode builder code as ASCII hex
  const codesHex = Array.from(new TextEncoder().encode(BUILDER_CODE))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");

  // codesLength = number of bytes in codes
  const codesLength = (codesHex.length / 2).toString(16).padStart(2, "0");

  return "0x" + codesHex + codesLength + SCHEMA_ID + ERC_MARKER;
}

export function addERC8021Attribution(existingData) {
  const suffix = getDataSuffix();
  if (!existingData || existingData === "0x") {
    return suffix;
  }
  const base = existingData.startsWith("0x") ? existingData.slice(2) : existingData;
  const suffixHex = suffix.startsWith("0x") ? suffix.slice(2) : suffix;
  return "0x" + base + suffixHex;
}
