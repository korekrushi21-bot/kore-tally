import asyncio
from collections import deque
import json
import logging
import re
import socket
import subprocess
import sys
import time
import winsound
from pathlib import Path

import numpy as np
import sounddevice as sd
from scipy.io.wavfile import write
from scipy.signal import butter, sosfilt
from faster_whisper import WhisperModel
import edge_tts

from command_parser import activated_command, parse_command
from tally_readonly import TallyReadOnly, summarize_receivables
from bill_draft import save_draft
from matching import normalize
from openai_command import understand_command

# Windows background launchers can inherit a non-Unicode console encoding.
# Keep Marathi status text from terminating the helper during startup.
for _stream in (sys.stdout, sys.stderr):
    if _stream is not None and hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent


def strict_wake_phrase_detected(text):
    compact = re.sub(r"[^a-z0-9\u0900-\u097f]+", " ", normalize(text)).strip()
    tokens = compact.split()
    if not tokens or len(tokens) > 4:
        return False
    variants = tuple(map(normalize, (
        "ok tally", "okay tally", "ok telly", "okay telly",
        "ओके टॅली", "ओके टेली", "ओके टाली", "ओके दिल्ली",
    )))
    return any(compact == variant for variant in variants)


def tally_port_open():
    try:
        with socket.create_connection(("127.0.0.1", 9000), timeout=1):
            return True
    except OSError:
        return False


def wait_for_ok_tally(config, model):
    """Offline wake detection using the already-loaded Whisper model."""
    voice = config.get("voice", {})
    rate = int(voice.get("sample_rate", 16000))
    input_device = voice.get("input_device")
    seconds = float(voice.get("wake_record_seconds", 3.0))
    try:
        audio = sd.rec(
            int(seconds * rate), samplerate=rate, channels=1,
            dtype="int16", device=input_device,
        )
        sd.wait()
    except sd.PortAudioError as exc:
        # A voice call or another app can temporarily hold the microphone.
        # Stay alive and retry instead of making the watcher reload Whisper.
        logging.warning("Microphone temporarily unavailable during wake: %s", exc)
        time.sleep(1.0)
        return False
    samples = audio.reshape(-1)
    if samples.size == 0 or float(np.sqrt(np.mean(samples.astype(np.float32) ** 2))) < 90:
        return False

    wake_file = ROOT / "logs" / "wake_command.wav"
    write(wake_file, rate, samples)
    segments, _ = model.transcribe(
        str(wake_file),
        language="en",
        beam_size=1,
        best_of=1,
        temperature=0.0,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 250, "speech_pad_ms": 200},
        condition_on_previous_text=False,
        hotwords="OK Tally Okay Tally",
        without_timestamps=True,
        max_new_tokens=8,
    )
    heard = normalize(" ".join(s.text.strip() for s in segments).strip())
    detected = strict_wake_phrase_detected(heard)
    logging.info("offline_wake_heard=%r", heard)
    if detected:
        # Hotword bias improves recall, but can hallucinate "OK Tally" from
        # room noise. Verify the same audio independently before beeping.
        verify_segments, _ = model.transcribe(
            str(wake_file),
            language="en",
            beam_size=3,
            best_of=3,
            temperature=0.0,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 250, "speech_pad_ms": 200},
            condition_on_previous_text=False,
            without_timestamps=True,
            max_new_tokens=8,
        )
        verified_heard = normalize(
            " ".join(s.text.strip() for s in verify_segments).strip()
        )
        logging.info("offline_wake_verified_heard=%r", verified_heard)
        detected = strict_wake_phrase_detected(verified_heard)
    logging.info("offline_wake_detected=%s", detected)
    return detected


def load_config():
    return json.loads(
        (ROOT / "config.json").read_text(encoding="utf-8")
    )


def setup_log():
    (ROOT / "logs").mkdir(exist_ok=True)

    logging.basicConfig(
        filename=ROOT / "logs" / "helper.log",
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        encoding="utf-8",
    )


def listen(config, model, session=None):
    voice = config["voice"]

    seconds = float(voice["record_seconds"])
    rate = int(voice["sample_rate"])
    input_device = voice.get("input_device")

    print()
    print(f"🎤 बोला... ({seconds:g} सेकंद)")

    # The selected WDM-KS microphone supports PortAudio callback recording but
    # not blocking InputStream.read(). sd.rec uses the supported callback path.
    recording = sd.rec(
        int(seconds * rate), samplerate=rate, channels=1,
        dtype="int16", device=input_device,
    )
    sd.wait()
    audio = recording.reshape(-1).astype(np.int16)

    # Local speech cleanup: remove DC/low-frequency rumble and normalize quiet
    # microphones without clipping. The original Tally data is never involved.
    cleaned = audio.astype(np.float32).reshape(-1)
    if cleaned.size == 0:
        return ""
    cleaned -= float(np.mean(cleaned))
    cleaned = sosfilt(
        butter(2, 80, btype="highpass", fs=rate, output="sos"),
        cleaned,
    )
    peak = float(np.max(np.abs(cleaned))) if cleaned.size else 0.0
    if peak > 1.0:
        cleaned *= (0.88 * 32767.0) / peak
    audio = np.clip(cleaned, -32768, 32767).astype(np.int16)

    # Keep the configured 10-second maximum, but send only the real speech
    # region to Whisper. Long room-silence tails can cause repeated-name
    # hallucinations on CPU models.
    frame = max(1, int(rate * 0.03))
    frame_count = len(audio) // frame
    if frame_count:
        framed = audio[:frame_count * frame].reshape(frame_count, frame)
        levels = np.sqrt(np.mean(framed.astype(np.float32) ** 2, axis=1))
        noise = float(np.percentile(levels, 30))
        threshold = max(120.0, noise * 2.8)
        active = np.flatnonzero(levels >= threshold)
        if active.size:
            pad = int(0.35 / 0.03)
            first = max(0, int(active[0]) - pad) * frame
            last = min(frame_count, int(active[-1]) + pad + 1) * frame
            audio = audio[first:last]

    temp = ROOT / "logs" / "last_command.wav"

    write(temp, rate, audio)

    command_language = voice.get("language", "mr")
    if session and session.get("outstanding_party"):
        command_language = "mr"
    if command_language == "auto":
        command_language = None

    segments, _ = model.transcribe(
        str(temp),
        language=command_language,
        multilingual=False,
        beam_size=3,
        best_of=3,
        patience=1.0,
        repetition_penalty=1.18,
        no_repeat_ngram_size=3,
        temperature=0.0,
        vad_filter=True,
        vad_parameters={
            "min_silence_duration_ms": 450,
            "speech_pad_ms": 350,
        },
        condition_on_previous_text=False,
        hallucination_silence_threshold=1.0,
        initial_prompt=(
            "मराठी Tally आदेश: अमिस्टार टॉप शंभर एमएल स्टॉक; "
            "अमिस्टार टॉप दोनशे एमएल स्टॉक; ग्राहक बाकी; "
            "आजची विक्री; आजची खरेदी; सेल्स बिल; परचेस बिल."
        ),
        hotwords=(
            "Amistar Top 100 ml 200 ml stock स्टॉक शंभर एमएल दोनशे एमएल "
            "ग्राहक बाकी customer outstanding sales purchase विक्री खरेदी"
        ),
    )

    result = " ".join(
        segment.text.strip()
        for segment in segments
    ).strip()
    words = normalize(result).split()
    if words and max(words.count(word) for word in set(words)) >= 5:
        logging.warning("Rejected repeated-word speech hallucination")
        return ""
    return result


async def make_speech(text):
    speech_file = ROOT / "logs" / "answer.mp3"

    # Marathi Microsoft neural voice
    voice_name = "mr-IN-AarohiNeural"

    communicate = edge_tts.Communicate(
        text=text,
        voice=voice_name,
        rate="+0%",
    )

    await communicate.save(str(speech_file))

    return speech_file


def play_mp3(file_path):
    uri = file_path.resolve().as_uri()

    powershell = f"""
Add-Type -AssemblyName PresentationCore
$player = New-Object System.Windows.Media.MediaPlayer
$player.Open([Uri]'{uri}')
$player.Play()

Start-Sleep -Milliseconds 500

while (-not $player.NaturalDuration.HasTimeSpan) {{
    Start-Sleep -Milliseconds 100
}}

$duration = $player.NaturalDuration.TimeSpan.TotalMilliseconds
Start-Sleep -Milliseconds ([int]$duration + 300)

$player.Close()
"""

    subprocess.run(
        [
            "powershell",
            "-NoProfile",
            "-Command",
            powershell,
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def speak(text):
    try:
        speech_file = asyncio.run(make_speech(text))
        play_mp3(speech_file)

    except Exception as exc:
        logging.exception("Speaker failed")

        print(
            "Speaker चालला नाही:",
            exc,
        )


def _match_message(label, result):
    if result["status"] == "not_found":
        return f"{label} जुळले नाही. पूर्ण नाव पुन्हा बोला."
    if result["status"] == "ambiguous":
        choices = ", ".join(x["name"] for x in result["matches"][:5])
        return f"{label}साठी एकापेक्षा जास्त नावे आहेत: {choices}. पूर्ण नाव पुन्हा बोला."
    return None


def handle_bill_wizard(text, config, session):
    wizard = session["bill_wizard"]
    clean = normalize(text)
    if any(word in clean for word in map(normalize, ("रद्द", "cancel", "बंद करा"))):
        session.clear()
        return "Bill draft रद्द केला. Tally मध्ये काहीही save झालेले नाही."

    step = wizard["step"]
    with TallyReadOnly(config) as tally:
        if step == "party":
            result = tally.resolve_name("ledger_names", clean)
            problem = _match_message("ग्राहक किंवा सप्लायर", result)
            if problem:
                return problem
            wizard["party"] = result["name"]
            wizard["step"] = "item"
            return f"{result['name']} निवडले. आता मालाचे पूर्ण नाव बोला."

        if step == "item":
            result = tally.resolve_name("stock_names", clean)
            problem = _match_message("माल", result)
            if problem:
                return problem
            wizard["item"] = result["name"]
            wizard["step"] = "quantity"
            return f"{result['name']} निवडले. आता फक्त quantity किंवा नग बोला."

    if step in {"quantity", "rate"}:
        number = re.search(r"\d+(?:\.\d+)?", clean)
        if not number:
            return "आकडा स्पष्ट ऐकू आला नाही. कृपया फक्त अंक पुन्हा बोला."
        value = float(number.group())
        if value <= 0:
            return "आकडा शून्यापेक्षा मोठा असला पाहिजे. पुन्हा बोला."
        if step == "quantity":
            wizard["quantity"] = value
            wizard["step"] = "rate"
            return f"नग {value:g}. आता फक्त एका नगाचा दर बोला."
        wizard["rate"] = value
        wizard["step"] = "confirm"
        amount = wizard["quantity"] * value
        return (
            f"Draft तपासा: {wizard['party']}, {wizard['item']}, "
            f"नग {wizard['quantity']:g}, दर {value:,.2f}, रक्कम {amount:,.2f} रुपये. "
            "बरोबर असल्यास हो म्हणा; रद्द करण्यासाठी रद्द म्हणा."
        )

    if step == "confirm":
        if not any(word in clean for word in map(normalize, ("हो", "yes", "बरोबर", "ठीक"))):
            return "Confirmation मिळाले नाही. हो किंवा रद्द म्हणा."
        record = save_draft(ROOT, {
            "voucher_type": wizard["voucher_type"],
            "party": wizard["party"],
            "item": wizard["item"],
            "quantity": wizard["quantity"],
            "rate": wizard["rate"],
            "amount_preview": wizard["quantity"] * wizard["rate"],
            "spoken_text": "STEP_BY_STEP_VOICE_WIZARD",
        })
        session.clear()
        return (
            f"{record['voucher_type']} bill draft तयार आहे. "
            "Tallyमध्ये save केलेले नाही. Operatorने तपासून manually save करावे."
        )


def format_result(parsed, config, session):
    fields = config["result_fields"]

    with TallyReadOnly(config) as tally:

        kind = parsed["kind"]

        if kind in {"sales_bill_draft", "purchase_bill_draft"}:
            missing = [name for name in ("party", "item", "quantity", "rate") if not parsed.get(name)]
            if missing:
                session["bill_wizard"] = {
                    "voucher_type": "Sales" if kind == "sales_bill_draft" else "Purchase",
                    "step": "party",
                }
                label = "ग्राहकाचे" if kind == "sales_bill_draft" else "सप्लायरचे"
                return f"{label} पूर्ण नाव बोला. रद्द करण्यासाठी रद्द म्हणा."
            party = tally.resolve_name("ledger_names", parsed["party"])
            item = tally.resolve_name("stock_names", parsed["item"])
            for label, result in (("ग्राहक किंवा सप्लायर", party), ("माल", item)):
                if result["status"] == "not_found":
                    return f"{label} जुळले नाही. पूर्ण नाव पुन्हा सांगा. Bill save झालेला नाही."
                if result["status"] == "ambiguous":
                    choices = ", ".join(x["name"] for x in result["matches"][:5])
                    return f"{label}साठी एकापेक्षा जास्त नावे आहेत: {choices}. Bill save झालेला नाही."
            record = save_draft(ROOT, {
                "voucher_type": "Sales" if kind == "sales_bill_draft" else "Purchase",
                "party": party["name"],
                "item": item["name"],
                "quantity": parsed["quantity"],
                "rate": parsed["rate"],
                "amount_preview": parsed["quantity"] * parsed["rate"],
                "spoken_text": parsed.get("spoken_text", ""),
            })
            return (
                f"{record['voucher_type']} bill draft तयार आहे. "
                f"{record['party']}, {record['item']}, "
                f"नग {record['quantity']:g}, दर {record['rate']:,.2f}, "
                f"रक्कम preview {record['amount_preview']:,.2f} रुपये. "
                "Tally मध्ये final save केलेले नाही. Operatorने तपासून manually save करावे."
            )

        if kind in {
            "today_sales",
            "today_purchases",
        }:

            data = tally.today_total(
                "sales"
                if kind == "today_sales"
                else "purchases"
            )

            label = (
                "आजची विक्री"
                if kind == "today_sales"
                else "आजची खरेदी"
            )

            if data["total"] is None:

                return (
                    f"{label} मध्ये "
                    f"{data['count']} नोंदी आहेत. "
                    "रकमेचे field mapping अजून पूर्ण झालेले नाही."
                )

            return (
                f"{label} "
                f"{data['count']} नोंदी, "
                f"एकूण {data['total']:,.2f} रुपये आहे."
            )

        if kind in {"total_outstanding", "top_outstanding"}:
            summary = summarize_receivables(tally.debtor_balances())
            if not summary["count"]:
                return "कोणाकडेही येणे बाकी सापडली नाही."
            if kind == "total_outstanding":
                return (
                    f"एकूण येणे बाकी {summary['total']:,.2f} रुपये आहे, "
                    f"{summary['count']} ग्राहकांकडे."
                )
            ranked = "; ".join(
                f"{i}. {name}, {amount:,.2f} रुपये"
                for i, (name, amount) in enumerate(summary["top"], 1)
            )
            return f"सर्वात जास्त बाकी: {ranked}."

        if not parsed.get("subject"):

            if kind == "party_outstanding":
                session["outstanding_party"] = True
                return "Customer चे पूर्ण नाव बोला."

            return (
                "नाव स्पष्ट ऐकू आले नाही. "
                "कृपया पूर्ण नाव पुन्हा सांगा."
            )

        if kind == "party_outstanding":

            data = tally.named_value(
                "ledger_names",
                "party_outstanding",
                parsed["subject"],
                fields["closing_balance"],
            )

        elif kind == "stock_inquiry":

            data = tally.named_value(
                "stock_names",
                "stock_value",
                parsed["subject"],
                fields["closing_quantity"],
            )

        else:

            data = tally.named_value(
                "group_names",
                "category_outstanding",
                parsed["subject"],
                fields["closing_balance"],
            )

        if data["status"] == "not_found":

            return (
                "जुळणारे नाव सापडले नाही. "
                "कृपया नाव पुन्हा स्पष्ट सांगा."
            )

        if data["status"] == "ambiguous":

            if kind == "stock_inquiry" and normalize(parsed.get("subject")) == normalize("Amistar Top"):
                session["stock_pack_choice"] = True
                return "Amistar Top चे packing सांगा: 100 ML की 200 ML?"

            choices = ", ".join(
                x["name"]
                for x in data["matches"][:5]
            )

            return (
                "एकापेक्षा जास्त नावे जुळत आहेत. "
                f"{choices}. "
                "कृपया पूर्ण नाव सांगा."
            )

        if kind == "stock_inquiry":

            return (
                f"{data['name']} चा उपलब्ध स्टॉक "
                f"{data['value']:,.2f} आहे."
            )

        if kind == "party_outstanding":
            value = float(data["value"])
            if value < 0:
                return (
                    f"{data['name']} यांच्याकडून घ्यायची एकूण बाकी "
                    f"{abs(value):,.2f} रुपये आहे."
                )
            if value > 0:
                return (
                    f"{data['name']} यांच्या खात्यावर जमा किंवा क्रेडिट शिल्लक "
                    f"{value:,.2f} रुपये आहे."
                )
            return f"{data['name']} यांची बाकी शून्य आहे."

        return (
            f"{data['name']} ची "
            f"बाकी {data['value']:,.2f} रुपये आहे."
        )


def handle(text, config, session):
    if session.get("outstanding_party"):
        logging.info("outstanding_followup_recognized=%r", text)
        candidate = parse_command(
            f"{config['wake_word']} {text} बाकी",
            config["wake_word"],
        )
        subject = candidate.get("subject", "") if candidate.get("kind") == "party_outstanding" else text
        session.pop("outstanding_party", None)
        try:
            return format_result(
                {"status": "ok", "kind": "party_outstanding", "subject": subject},
                config, session,
            )
        except Exception:
            logging.exception("Outstanding party follow-up failed")
            return "Customer बाकी मिळाली नाही. पूर्ण नाव पुन्हा सांगा."
    if session.get("stock_pack_choice"):
        clean = normalize(text)
        logging.info("packing_followup_recognized=%r", text)
        hundred = any(x in clean for x in map(normalize, (
            "100", "100 ml", "one zero zero", "hundred", "शंभर",
            "सम्बरे", "संबरे", "चमबरे", "चंबरे", "चम्बरे", "शंबरे",
            "shambarya", "shambare", "chambare", "chambare mail",
            "shambare mail", "chambaremen", "one hundred", "hundred ml",
            "वन झिरो झिरो", "वन हंड्रेड", "सौ", "शे",
        )))
        two_hundred = any(x in clean for x in map(normalize, (
            "200", "200 ml", "two zero zero", "two hundred", "दोनशे",
            "दो सौ", "टू झिरो झिरो", "टू हंड्रेड",
        )))
        if hundred == two_hundred:
            return "Packing स्पष्ट सांगा: फक्त 100 ML किंवा 200 ML म्हणा."
        session.pop("stock_pack_choice", None)
        parsed = {
            "status": "ok", "kind": "stock_inquiry",
            "subject": "Amistar Top 100ml" if hundred else "Amistar Top 200ml",
        }
        try:
            return format_result(parsed, config, session)
        except Exception:
            logging.exception("Stock packing follow-up failed")
            return "Packing stock मिळाला नाही. कृपया पुन्हा प्रयत्न करा."
    if session.get("bill_wizard"):
        try:
            return handle_bill_wizard(text, config, session)
        except Exception:
            logging.exception("Bill wizard failed")
            return "Bill draft प्रक्रिया अडली. Tallyमध्ये काहीही save झालेले नाही. पुन्हा प्रयत्न करा."
    parsed = parse_command(
        text,
        config["wake_word"],
    )

    logging.info(
        "recognized=%r parsed=%s",
        text,
        json.dumps(
            parsed,
            ensure_ascii=False,
        ),
    )

    if parsed["status"] == "ignored":

        return (
            "ओके टॅली हा शब्द ऐकू आला नाही. "
            "कृपया ओके टॅली असे बोलून पुन्हा सांगा."
        )

    if parsed["status"] == "unknown":
        try:
            parsed = understand_command(text, config)
            logging.info("openai_parser_status=%s kind=%s", parsed.get("status"), parsed.get("kind"))
        except Exception:
            logging.exception("OpenAI command understanding failed")
            parsed = {"status": "unknown", "reason": "connection_failed"}
        if parsed["status"] != "ok":
            return (
                "मला ही कमांड समजली नाही. "
                "कृपया पुन्हा सांगा."
            )

    try:
        return format_result(
            parsed,
            config,
            session,
        )

    except Exception as exc:

        logging.exception(
            "Tally query failed"
        )

        return (
            "टॅली मधून माहिती मिळाली नाही. "
            "कृपया पुन्हा प्रयत्न करा."
        )


def main():
    setup_log()

    config = load_config()
    auto_mode = "--auto" in sys.argv

    # Safety lock
    if (
        config.get("mode") != "READ_ONLY_TEST"
        or config.get("writes_enabled") is not False
    ):
        raise SystemExit(
            "Safety lock failed. "
            "READ ONLY mode आवश्यक आहे."
        )

    print()
    print("======================================")
    print("   कोरे कृषी सेवा केंद्र")
    print("   मराठी Voice Assistant")
    print("======================================")
    print()
    print("READ ONLY MODE")
    print("Tally data मध्ये कोणताही बदल होणार नाही.")
    print()

    print("Marathi speech model load होत आहे...")

    session = {}

    voice_config = config["voice"]

    model = WhisperModel(
        voice_config["model"],
        device=voice_config["device"],
        compute_type=voice_config["compute_type"],
        download_root=str(ROOT / "_models"),
    )

    print("✅ Voice Assistant तयार आहे.")
    print()

    while True:
        if auto_mode:
            if not tally_port_open():
                return
            if not wait_for_ok_tally(config, model):
                continue
            winsound.Beep(850, 180)
            winsound.Beep(1200, 220)
        else:
            input(
                "🎤 बोलण्यासाठी Enter दाबा "
                "| बंद करण्यासाठी Ctrl+C: "
            )

        try:
            text = listen(
                config,
                model,
                session,
            )
        except sd.PortAudioError as exc:
            logging.warning("Microphone temporarily unavailable during command: %s", exc)
            time.sleep(1.0)
            continue

        print()
        print("ऐकले:", text or "(रिकामे)")

        if not text:
            speak(
                "आवाज स्पष्ट ऐकू आला नाही. "
                "कृपया पुन्हा सांगा."
            )
            continue

        # Pressing Enter or the separate OK Tally listener is itself the
        # activation. Do not force the user to repeat the wake word inside the
        # recorded command.
        command_text = activated_command(text, config["wake_word"])

        answer = handle(
            command_text,
            config,
            session,
        )

        print()
        print("उत्तर:", answer)
        print()

        # Speaker वर Marathi answer
        speak(answer)

        logging.info(
            "answer=%s",
            answer,
        )


if __name__ == "__main__":
    main()
