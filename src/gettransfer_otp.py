#!/usr/bin/env python3

import argparse
import email
import email.utils
import imaplib
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--email", required=True)
    parser.add_argument("--since-epoch-ms", required=True, type=int)
    parser.add_argument("--timeout", type=int, default=180)
    return parser.parse_args()


def load_env_if_needed():
    if os.getenv("GMAIL_USER") and os.getenv("GMAIL_PASS"):
        return

    candidates = [
        Path(".env"),
        Path("../.env"),
        Path("/home/creamer/Downloads/claude/OTS-Autobid/.env"),
        Path("/home/creamer/Downloads/claude/OTS-Autobid/data/.env"),
    ]

    for candidate in candidates:
        if not candidate.exists():
            continue
        try:
            for line in candidate.read_text(errors="ignore").splitlines():
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                key = key.strip()
                value = value.strip()
                if key in {"GMAIL_USER", "GMAIL_PASS"} and not os.getenv(key):
                    os.environ[key] = value
        except Exception:
            continue

        if os.getenv("GMAIL_USER") and os.getenv("GMAIL_PASS"):
            return


def decode_text(payload):
    if payload is None:
        return ""
    if isinstance(payload, bytes):
        for encoding in ("utf-8", "latin-1"):
            try:
                return payload.decode(encoding)
            except Exception:
                continue
        return payload.decode("utf-8", errors="ignore")
    return str(payload)


def message_text(msg):
    if msg.is_multipart():
      parts = []
      for part in msg.walk():
          if part.get_content_maintype() == "multipart":
              continue
          if part.get_content_disposition() == "attachment":
              continue
          if part.get_content_type() in ("text/plain", "text/html"):
              parts.append(
                  decode_text(part.get_payload(decode=True) or part.get_payload())
              )
      return "\n".join(parts)
    return decode_text(msg.get_payload(decode=True) or msg.get_payload())


def find_code(imap_conn, mailbox, target_email, since_epoch_ms):
    status, _ = imap_conn.select(mailbox, readonly=True)
    if status != "OK":
        return None

    status, data = imap_conn.search(None, '(SUBJECT "Confirmation code")')
    if status != "OK" or not data or not data[0]:
        return None

    ids = data[0].split()
    ids.reverse()

    for msg_id in ids[:25]:
        status, fetched = imap_conn.fetch(msg_id, "(RFC822)")
        if status != "OK" or not fetched or not fetched[0]:
            continue

        raw = fetched[0][1]
        msg = email.message_from_bytes(raw)
        to_header = msg.get("To", "")
        if target_email.lower() not in to_header.lower():
            continue

        date_header = msg.get("Date")
        parsed_date = email.utils.parsedate_to_datetime(date_header) if date_header else None
        if parsed_date is not None:
            if parsed_date.tzinfo is None:
                parsed_date = parsed_date.replace(tzinfo=timezone.utc)
            if parsed_date.timestamp() * 1000 < since_epoch_ms - 120000:
                continue

        text = message_text(msg)
        match = re.search(r"Your code\s+(\d{4,8})", text, re.IGNORECASE | re.MULTILINE)
        if match:
            return match.group(1)

    return None


def main():
    args = parse_args()
    load_env_if_needed()

    gmail_user = os.getenv("GMAIL_USER")
    gmail_pass = os.getenv("GMAIL_PASS")

    if not gmail_user or not gmail_pass:
        print("Missing GMAIL_USER or GMAIL_PASS", file=sys.stderr)
        sys.exit(1)

    deadline = time.time() + args.timeout
    last_error = None

    while time.time() < deadline:
        imap_conn = None
        try:
            imap_conn = imaplib.IMAP4_SSL("imap.gmail.com", timeout=60)
            imap_conn.login(gmail_user, gmail_pass)

            for mailbox in ("INBOX", '"[Gmail]/All Mail"'):
                code = find_code(imap_conn, mailbox, args.email, args.since_epoch_ms)
                if code:
                    print(code)
                    return

        except Exception as exc:
            last_error = str(exc)
        finally:
            if imap_conn is not None:
                try:
                    imap_conn.logout()
                except Exception:
                    pass

        time.sleep(10)

    if last_error:
        print(last_error, file=sys.stderr)
    else:
        since_iso = datetime.fromtimestamp(args.since_epoch_ms / 1000, tz=timezone.utc).isoformat()
        print(
            f"No confirmation code email found for {args.email} after {since_iso}",
            file=sys.stderr,
        )
    sys.exit(1)


if __name__ == "__main__":
    main()
