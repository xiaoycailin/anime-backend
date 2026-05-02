type VideoProbe = {
  width: number;
  height: number;
  codec: "h264";
};

class BitReader {
  private bitOffset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  readBits(length: number) {
    let value = 0;
    for (let i = 0; i < length; i += 1) {
      const byte = this.bytes[this.bitOffset >> 3] ?? 0;
      value = (value << 1) | ((byte >> (7 - (this.bitOffset & 7))) & 1);
      this.bitOffset += 1;
    }
    return value;
  }

  readBool() {
    return this.readBits(1) === 1;
  }

  readUe() {
    let zeros = 0;
    while (this.readBits(1) === 0 && zeros < 32) zeros += 1;
    return (1 << zeros) - 1 + (zeros > 0 ? this.readBits(zeros) : 0);
  }

  readSe() {
    const value = this.readUe();
    return (value & 1) === 0 ? -(value >> 1) : (value + 1) >> 1;
  }
}

function stripEmulationPrevention(bytes: Uint8Array) {
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i += 1) {
    if (i >= 2 && bytes[i] === 0x03 && bytes[i - 1] === 0x00 && bytes[i - 2] === 0x00) continue;
    out.push(bytes[i]);
  }
  return new Uint8Array(out);
}

function skipScalingList(reader: BitReader, count: number) {
  let lastScale = 8;
  let nextScale = 8;
  for (let i = 0; i < count; i += 1) {
    if (nextScale !== 0) {
      const deltaScale = reader.readSe();
      nextScale = (lastScale + deltaScale + 256) % 256;
    }
    lastScale = nextScale === 0 ? lastScale : nextScale;
  }
}

function parseH264Sps(nal: Uint8Array): VideoProbe | null {
  const rbsp = stripEmulationPrevention(nal.slice(1));
  const reader = new BitReader(rbsp);
  const profileIdc = reader.readBits(8);
  reader.readBits(16);
  reader.readUe();

  const highProfiles = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 144]);
  let chromaFormatIdc = 1;
  if (highProfiles.has(profileIdc)) {
    chromaFormatIdc = reader.readUe();
    if (chromaFormatIdc === 3) reader.readBits(1);
    reader.readUe();
    reader.readUe();
    reader.readBits(1);
    if (reader.readBool()) {
      const count = chromaFormatIdc !== 3 ? 8 : 12;
      for (let i = 0; i < count; i += 1) {
        if (reader.readBool()) skipScalingList(reader, i < 6 ? 16 : 64);
      }
    }
  }

  reader.readUe();
  const picOrderCntType = reader.readUe();
  if (picOrderCntType === 0) {
    reader.readUe();
  } else if (picOrderCntType === 1) {
    reader.readBits(1);
    reader.readSe();
    reader.readSe();
    const cycle = reader.readUe();
    for (let i = 0; i < cycle; i += 1) reader.readSe();
  }

  reader.readUe();
  reader.readBits(1);
  const picWidthInMbsMinus1 = reader.readUe();
  const picHeightInMapUnitsMinus1 = reader.readUe();
  const frameMbsOnlyFlag = reader.readBits(1);
  if (!frameMbsOnlyFlag) reader.readBits(1);
  reader.readBits(1);

  let cropLeft = 0;
  let cropRight = 0;
  let cropTop = 0;
  let cropBottom = 0;
  if (reader.readBool()) {
    cropLeft = reader.readUe();
    cropRight = reader.readUe();
    cropTop = reader.readUe();
    cropBottom = reader.readUe();
  }

  const subWidthC = chromaFormatIdc === 1 || chromaFormatIdc === 2 ? 2 : 1;
  const subHeightC = chromaFormatIdc === 1 ? 2 : 1;
  const cropUnitX = chromaFormatIdc === 0 ? 1 : subWidthC;
  const cropUnitY = chromaFormatIdc === 0 ? 2 - frameMbsOnlyFlag : subHeightC * (2 - frameMbsOnlyFlag);
  const width = (picWidthInMbsMinus1 + 1) * 16 - (cropLeft + cropRight) * cropUnitX;
  const height = (2 - frameMbsOnlyFlag) * (picHeightInMapUnitsMinus1 + 1) * 16 - (cropTop + cropBottom) * cropUnitY;
  return width > 0 && height > 0 ? { width, height, codec: "h264" } : null;
}

function splitAnnexBNals(bytes: Uint8Array) {
  const ranges: Array<[number, number]> = [];
  let start = -1;
  for (let i = 0; i < bytes.length - 3; i += 1) {
    const codeLength =
      bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1
        ? 3
        : bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 0 && bytes[i + 3] === 1
          ? 4
          : 0;
    if (!codeLength) continue;
    if (start >= 0) ranges.push([start, i]);
    start = i + codeLength;
    i += codeLength - 1;
  }
  if (start >= 0) ranges.push([start, bytes.length]);
  return ranges.map(([from, to]) => bytes.slice(from, to)).filter((nal) => nal.length > 0);
}

function findVideoPidFromPmt(packet: Uint8Array, startOffset: number) {
  const pointer = packet[1] & 0x40 ? packet[startOffset] + 1 : 0;
  let offset = startOffset + pointer;
  if (packet[offset] !== 0x02) return null;
  const sectionLength = ((packet[offset + 1] & 0x0f) << 8) | packet[offset + 2];
  const programInfoLength = ((packet[offset + 10] & 0x0f) << 8) | packet[offset + 11];
  offset += 12 + programInfoLength;
  const end = Math.min(startOffset + pointer + 3 + sectionLength - 4, packet.length);
  while (offset + 4 < end) {
    const streamType = packet[offset];
    const pid = ((packet[offset + 1] & 0x1f) << 8) | packet[offset + 2];
    const esInfoLength = ((packet[offset + 3] & 0x0f) << 8) | packet[offset + 4];
    if (streamType === 0x1b) return pid;
    offset += 5 + esInfoLength;
  }
  return null;
}

function payloadOffset(packet: Uint8Array) {
  const adaptation = (packet[3] >> 4) & 0x03;
  if (adaptation === 0 || adaptation === 2) return null;
  let offset = 4;
  if (adaptation === 3) offset += 1 + packet[4];
  return offset < packet.length ? offset : null;
}

function parseTsForH264(bytes: Uint8Array): VideoProbe | null {
  let pmtPid: number | null = null;
  let videoPid: number | null = null;
  const payloads: number[] = [];

  for (let offset = 0; offset + 188 <= bytes.length; offset += 188) {
    const packet = bytes.slice(offset, offset + 188);
    if (packet[0] !== 0x47) continue;
    const pid = ((packet[1] & 0x1f) << 8) | packet[2];
    const start = payloadOffset(packet);
    if (start === null) continue;

    if (pid === 0 && packet[1] & 0x40) {
      const pointer = packet[start];
      const table = start + 1 + pointer;
      if (packet[table] === 0x00) pmtPid = ((packet[table + 10] & 0x1f) << 8) | packet[table + 11];
      continue;
    }
    if (pmtPid !== null && pid === pmtPid) {
      videoPid = findVideoPidFromPmt(packet, start) ?? videoPid;
      continue;
    }
    if (videoPid !== null && pid === videoPid) {
      let payloadStart = start;
      if (packet[1] & 0x40 && packet[start] === 0x00 && packet[start + 1] === 0x00 && packet[start + 2] === 0x01) {
        payloadStart = start + 9 + (packet[start + 8] ?? 0);
      }
      for (let i = payloadStart; i < packet.length; i += 1) payloads.push(packet[i]);
    }
  }

  const pes = new Uint8Array(payloads);
  for (const nal of splitAnnexBNals(pes)) {
    if ((nal[0] & 0x1f) === 7) return parseH264Sps(nal);
  }
  return null;
}

export async function probeHlsSegmentDimensions(url: string, timeoutMs = 10000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 AnimeAdminSignalAnalyzer/1.0" },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return parseTsForH264(new Uint8Array(await response.arrayBuffer()));
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
