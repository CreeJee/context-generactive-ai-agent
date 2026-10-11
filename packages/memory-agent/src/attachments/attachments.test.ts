import { expect, test } from "vite-plus/test";
import { sniffImageType } from "./attachments.ts";

test("sniffImageType reads the type from the bytes", () => {
  expect(sniffImageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe(
    "image/png",
  );
  expect(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
  expect(sniffImageType(Buffer.from("GIF89a"))).toBe("image/gif");
  expect(sniffImageType(Buffer.from("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
  expect(sniffImageType(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
});
