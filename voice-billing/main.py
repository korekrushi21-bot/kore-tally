import json
import logging
import sys
import time
import signal
from pathlib import Path
from typing import Optional

import sounddevice as sd

from utils import setup_logging, ensure_utf8_streams
from stt_engine import STTEngine
from tts_engine import TTSEngine, TTSMessages
from tally_client import TallyClient
from billing_workflow import BillingWorkflow
from command_parser import CommandParser


ensure_utf8_streams()


class VoiceBillingApp:
    def __init__(self, config_path: str = "config.json"):
        self.root = Path(__file__).resolve().parent
        self.config = self._load_config(config_path)
        self.log_dir = self.root / "logs"
        self.log_dir.mkdir(parents=True, exist_ok=True)

        setup_logging(self.log_dir)

        self.stt = STTEngine(self.config["voice"])
        self.tts = TTSEngine(self.config["tts"])
        self.tts_messages = TTSMessages(self.tts)
        self.tally = TallyClient(
            host=self.config["tally"]["host"],
            port=self.config["tally"]["port"],
            company=self.config["tally"]["company"],
            timeout=self.config["tally"].get("timeout", 10),
        )
        self.workflow = BillingWorkflow(self.tally, self.config, str(self.log_dir))
        self.parser = CommandParser(self.config.get("wake_word", "टॅली सुरू कर"))

        self.running = False
        self.auto_mode = False

    def _load_config(self, config_path: str) -> dict:
        path = Path(config_path)
        if not path.is_absolute():
            path = self.root / config_path
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)

    def run(self, auto_mode: bool = False):
        self.auto_mode = auto_mode
        self.running = True

        print("\n" + "=" * 50)
        print("   कोरे कृषी सेवा केंद्र")
        print("   Voice Billing Assistant for TallyPrime")
        print("=" * 50)
        print()

        if not self._check_tally_connection():
            print("ERROR: Tally connection failed. Ensure Tally is running with HTTP gateway on port 9000.")
            return

        print("Loading Whisper model...")
        self.stt.load_model()
        print("✅ Voice Assistant ready.")
        print()
        print(f"Wake phrase: '{self.config.get('wake_word', 'टॅली सुरू कर')}'")
        print("Say wake phrase to start billing session.")
        print("Press Ctrl+C to exit.")
        print()

        if auto_mode:
            self._run_auto_loop()
        else:
            self._run_manual_loop()

    def _check_tally_connection(self) -> bool:
        print("Checking Tally connection...")
        if self.tally.test_connection():
            print("[OK] Tally connected.")
            return True
        print("[FAIL] Tally not reachable.")
        return False

    def _run_auto_loop(self):
        print("Auto mode: Listening for wake phrase...")
        while self.running:
            try:
                if self.workflow.check_session_timeout():
                    print("Session timed out. Returning to idle.")
                    continue

                if self.workflow.session.state.name == "IDLE":
                    print("💤 Waiting for wake phrase...")
                    if self.stt.listen_for_wake():
                        print("🎯 Wake phrase detected!")
                        response = self.workflow.handle_wake()
                        print(f"🤖: {response}")
                        self.tts.speak(response)
                        self.workflow.session.touch()
                    continue

                print("🎤 Listening for command...")
                text = self.stt.listen_command(self.workflow.session.__dict__)
                if not text:
                    self.tts_messages.no_speech()
                    continue

                print(f"🗣️  Heard: {text}")
                parsed = self.parser.parse(text, session_active=True)

                if parsed["status"] == "ignored":
                    print("Wake word missing in command.")
                    continue

                response = self.workflow.handle_command(parsed["payload"])
                if response:
                    print(f"🤖: {response}")
                    self.tts.speak(response)
                self.workflow.session.touch()

            except KeyboardInterrupt:
                break
            except sd.PortAudioError as e:
                logging.warning(f"Microphone error: {e}")
                time.sleep(1)
            except Exception as e:
                logging.exception("Error in auto loop")
                print(f"Error: {e}")
                time.sleep(1)

    def _run_manual_loop(self):
        print("Manual mode: Press Enter to listen, or type 'wake' to simulate wake phrase.")
        while self.running:
            try:
                if self.workflow.check_session_timeout():
                    print("Session timed out. Returning to idle.")
                    continue

                if self.workflow.session.state.name == "IDLE":
                    user_input = input("\n🎤 Press Enter to listen for wake phrase (or type 'wake'): ").strip().lower()
                    if user_input == "wake":
                        print("🎯 Simulated wake phrase detected!")
                        response = self.workflow.handle_wake()
                        print(f"🤖: {response}")
                        self.tts.speak(response)
                        self.workflow.session.touch()
                    elif user_input == "exit":
                        break
                    continue

                print("🎤 Listening for command... (Press Ctrl+C to cancel)")
                text = self.stt.listen_command(self.workflow.session.__dict__)
                if not text:
                    self.tts_messages.no_speech()
                    continue

                print(f"🗣️  Heard: {text}")
                parsed = self.parser.parse(text, session_active=True)

                if parsed["status"] == "ignored":
                    print("Wake word missing in command.")
                    continue

                response = self.workflow.handle_command(parsed["payload"])
                if response:
                    print(f"🤖: {response}")
                    self.tts.speak(response)
                self.workflow.session.touch()

            except KeyboardInterrupt:
                if self.workflow.session.state.name != "IDLE":
                    print("\n⚠️  Session active. Say 'रद्द' to cancel or press Ctrl+C again to force exit.")
                    continue
                break
            except sd.PortAudioError as e:
                logging.warning(f"Microphone error: {e}")
                time.sleep(1)
            except Exception as e:
                logging.exception("Error in manual loop")
                print(f"Error: {e}")
                time.sleep(1)

    def shutdown(self):
        self.running = False
        print("\nShutting down...")


def main():
    import argparse
    parser = argparse.ArgumentParser(description="Voice Billing Assistant for TallyPrime")
    parser.add_argument("--config", default="config.json", help="Config file path")
    parser.add_argument("--auto", action="store_true", help="Auto mode (continuous wake detection)")
    parser.add_argument("--test-stt", action="store_true", help="Test STT only")
    parser.add_argument("--test-tts", action="store_true", help="Test TTS only")
    parser.add_argument("--test-tally", action="store_true", help="Test Tally connection only")
    args = parser.parse_args()

    app = VoiceBillingApp(args.config)

    if args.test_stt:
        app.stt.load_model()
        print("STT test - speak something...")
        text = app.stt.listen_command({})
        print(f"Heard: {text}")
        return

    if args.test_tts:
        app.tts.speak("टॅली वॉइस बिलिंग सिस्टम तयार आहे.")
        return

    if args.test_tally:
        if app._check_tally_connection():
            ledgers = app.tally.get_ledgers_under("Sundry Debtors")
            print(f"Found {len(ledgers)} sundry debtors")
            for l in ledgers[:5]:
                print(f"  - {l.name}: {l.closing_balance:,.2f}")
            items = app.tally.get_stock_items()
            print(f"Found {len(items)} stock items")
            for i in items[:5]:
                print(f"  - {i.name}: rate={i.closing_rate}, unit={i.unit}")
        return

    def signal_handler(sig, frame):
        app.shutdown()
        sys.exit(0)

    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)

    app.run(auto_mode=args.auto)


if __name__ == "__main__":
    main()