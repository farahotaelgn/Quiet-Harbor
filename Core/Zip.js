import { ByteWriter, concatBytes, crc32, utf8 } from './Binary.js';
export function zip(files, date = new Date()) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const name = utf8.encode(file.name);
    const crc = crc32(file.data);
    const local = new ByteWriter();
    local.u32(0x04034b50); local.u16(20); local.u16(0x0800); local.u16(0);
    local.u16(time); local.u16(day); local.u32(crc);
    local.u32(file.data.length); local.u32(file.data.length);
    local.u16(name.length); local.u16(0); local.append(name);
    const header = local.toBytes();
    parts.push(header, file.data);

    const entry = new ByteWriter();
    entry.u32(0x02014b50); entry.u16(20); entry.u16(20); entry.u16(0x0800); entry.u16(0);
    entry.u16(time); entry.u16(day); entry.u32(crc);
    entry.u32(file.data.length); entry.u32(file.data.length);
    entry.u16(name.length); entry.u16(0); entry.u16(0); entry.u16(0); entry.u16(0);
    entry.u32(0); entry.u32(offset); entry.append(name);
    central.push(entry.toBytes());
    offset += header.length + file.data.length;
  }
  const directory = concatBytes(central);
  const end = new ByteWriter();
  end.u32(0x06054b50); end.u16(0); end.u16(0);
  end.u16(files.length); end.u16(files.length);
  end.u32(directory.length); end.u32(offset); end.u16(0);
  return concatBytes([...parts, directory, end.toBytes()]);
}
