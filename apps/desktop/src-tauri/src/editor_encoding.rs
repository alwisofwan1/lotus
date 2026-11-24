//! Text encodings for the editor: a file is read in the encoding it is in and saved back in it.
//!
//! Before this, anything that was not valid UTF-8 — a Latin-1 or Windows-1252 file, a UTF-16
//! file from Windows — opened as "Binary" locally, and over SSH failed outright. Now:
//!
//! - a byte-order mark names the encoding (UTF-8, UTF-16 LE, UTF-16 BE) and is kept on save;
//! - valid UTF-8 is UTF-8 (even with NULs in it, as before: plenty of source files have some);
//! - anything else with a NUL or many control bytes in its first 8 KiB is binary;
//! - so is text in a multi-byte legacy encoding (Shift-JIS, GBK, EUC-KR, Big5): there is no
//!   reliable way to tell those apart, and read as Windows-1252 they are editable garbage that a
//!   save would corrupt. They keep the old safe "cannot open" screen;
//! - the rest is Windows-1252, a superset of Latin-1, which decodes every byte.
//!
//! The encoding travels with the buffer as one of the ids below and comes back with the save.

use crate::AppError;
use encoding_rs::{UTF_16BE, UTF_16LE, WINDOWS_1252};

pub const UTF8: &str = "utf8";
pub const UTF8_BOM: &str = "utf8bom";
pub const UTF16LE: &str = "utf16le";
pub const UTF16BE: &str = "utf16be";
pub const WINDOWS1252: &str = "windows1252";

const UTF8_BOM_BYTES: &[u8] = &[0xEF, 0xBB, 0xBF];
const UTF16LE_BOM_BYTES: &[u8] = &[0xFF, 0xFE];
const UTF16BE_BOM_BYTES: &[u8] = &[0xFE, 0xFF];
/// How much of a file the binary check looks at, as git and VS Code do.
const SNIFF_BYTES: usize = 8192;

#[derive(Debug, PartialEq, Eq)]
pub struct DecodedText {
    pub content: String,
    pub encoding: &'static str,
}

/// The text in `bytes`, or `None` when they are binary.
pub fn decode(bytes: &[u8]) -> Option<DecodedText> {
    let text = |content: String, encoding| Some(DecodedText { content, encoding });
    if let Some(rest) = bytes.strip_prefix(UTF8_BOM_BYTES) {
        return text(std::str::from_utf8(rest).ok()?.to_owned(), UTF8_BOM);
    }
    if let Some(rest) = bytes.strip_prefix(UTF16LE_BOM_BYTES) {
        return decode_utf16(rest, UTF16LE);
    }
    if let Some(rest) = bytes.strip_prefix(UTF16BE_BOM_BYTES) {
        return decode_utf16(rest, UTF16BE);
    }
    if let Ok(content) = std::str::from_utf8(bytes) {
        return text(content.to_owned(), UTF8);
    }
    let sample = &bytes[..bytes.len().min(SNIFF_BYTES)];
    if looks_binary(sample) || looks_multibyte(sample) {
        return None;
    }
    let (content, _) = WINDOWS_1252.decode_without_bom_handling(bytes);
    text(content.into_owned(), WINDOWS1252)
}

fn decode_utf16(bytes: &[u8], encoding: &'static str) -> Option<DecodedText> {
    let codec = if encoding == UTF16LE { UTF_16LE } else { UTF_16BE };
    // An odd byte count or a lone surrogate is not UTF-16 text.
    let content = codec.decode_without_bom_handling_and_without_replacement(bytes)?;
    if content.contains('\0') {
        return None;
    }
    Some(DecodedText {
        content: content.into_owned(),
        encoding,
    })
}

/// A NUL, or more than one byte in 20 that is a control code no text file uses.
fn looks_binary(sample: &[u8]) -> bool {
    if sample.contains(&0) {
        return true;
    }
    let odd = sample
        .iter()
        .filter(|&&byte| byte < 0x20 && !matches!(byte, b'\t' | b'\n' | b'\r' | 0x0C | 0x1B))
        .count();
    odd * 20 > sample.len()
}

/// Most bytes ≥ 0x80 sit next to another one: a double-byte encoding (each CJK character is two
/// high bytes, a sentence is a long run of them). In Latin-1/Windows-1252 text an accented letter
/// or a smart quote stands alone between ASCII letters.
fn looks_multibyte(sample: &[u8]) -> bool {
    let high = |index: usize| sample.get(index).is_some_and(|byte| *byte >= 0x80);
    let mut total = 0;
    let mut paired = 0;
    for index in 0..sample.len() {
        if !high(index) {
            continue;
        }
        total += 1;
        if (index > 0 && high(index - 1)) || high(index + 1) {
            paired += 1;
        }
    }
    total >= 4 && paired * 2 > total
}

/// `text` as bytes in `encoding` (an id from [`decode`]; empty or absent means UTF-8).
pub fn encode(text: &str, encoding: Option<&str>) -> Result<Vec<u8>, AppError> {
    match encoding.unwrap_or(UTF8) {
        "" | UTF8 => Ok(text.as_bytes().to_vec()),
        UTF8_BOM => Ok([UTF8_BOM_BYTES, text.as_bytes()].concat()),
        UTF16LE => Ok(UTF16LE_BOM_BYTES
            .iter()
            .copied()
            .chain(text.encode_utf16().flat_map(u16::to_le_bytes))
            .collect()),
        UTF16BE => Ok(UTF16BE_BOM_BYTES
            .iter()
            .copied()
            .chain(text.encode_utf16().flat_map(u16::to_be_bytes))
            .collect()),
        WINDOWS1252 => {
            let (bytes, _, unmappable) = WINDOWS_1252.encode(text);
            if unmappable {
                return Err(AppError::Other(
                    "This file is saved as Windows 1252, which cannot hold some of the characters in it (emoji, CJK, ...). Remove them, or convert the file to UTF-8 first.".to_string(),
                ));
            }
            Ok(bytes.into_owned())
        }
        other => Err(AppError::Other(format!("Unknown text encoding: {other}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn round_trip(bytes: &[u8], expected_text: &str, expected_encoding: &str) {
        let decoded = decode(bytes).expect("text");
        assert_eq!(decoded.content, expected_text);
        assert_eq!(decoded.encoding, expected_encoding);
        assert_eq!(encode(&decoded.content, Some(decoded.encoding)).unwrap(), bytes);
    }

    #[test]
    fn utf8_stays_utf8_and_keeps_nuls() {
        round_trip("héllo\n".as_bytes(), "héllo\n", UTF8);
        round_trip(b"a\0b", "a\0b", UTF8);
    }

    #[test]
    fn a_bom_names_the_encoding_and_is_written_back() {
        round_trip(b"\xEF\xBB\xBFhi", "hi", UTF8_BOM);
        round_trip(b"\xFF\xFEh\0i\0", "hi", UTF16LE);
        round_trip(b"\xFE\xFF\0h\0i", "hi", UTF16BE);
    }

    #[test]
    fn latin1_and_windows_1252_open_as_text() {
        // "café – €5" in Windows-1252: é = E9, en dash = 96, euro = 80.
        round_trip(b"caf\xE9 \x96 \x805", "café – €5", WINDOWS1252);
    }

    #[test]
    fn binary_stays_binary() {
        assert!(decode(b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\xff").is_none());
        assert!(decode(&[0x01, 0x02, 0x03, 0xFF, 0x04, 0x05]).is_none());
        // A UTF-16 BOM followed by an odd byte count is not UTF-16.
        assert!(decode(b"\xFF\xFEa").is_none());
    }

    #[test]
    fn shift_jis_and_gbk_are_not_read_as_windows_1252() {
        // "日本語のテキスト" in Shift-JIS, and "中文文本" in GBK.
        let (sjis, _, _) = encoding_rs::SHIFT_JIS.encode("日本語のテキスト\n");
        assert!(decode(&sjis).is_none());
        let (gbk, _, _) = encoding_rs::GBK.encode("中文文本\n");
        assert!(decode(&gbk).is_none());
        // German and French Windows-1252 text still opens: "Müller, ça coûte 5 €".
        let (latin, _, _) = WINDOWS_1252.encode("Müller, ça coûte 5 € — “oui”\n");
        assert_eq!(decode(&latin).unwrap().encoding, WINDOWS1252);
    }

    #[test]
    fn windows_1252_refuses_what_it_cannot_hold() {
        assert!(encode("ok é", Some(WINDOWS1252)).is_ok());
        assert!(encode("no 😀", Some(WINDOWS1252)).is_err());
        assert!(encode("x", Some("klingon")).is_err());
        assert_eq!(encode("x", None).unwrap(), b"x");
    }
}
