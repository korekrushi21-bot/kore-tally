import asyncio
import logging
import subprocess
import tempfile
from pathlib import Path
from typing import Optional
import edge_tts


class TTSEngine:
    def __init__(self, config: dict):
        self.config = config
        self.voice = config.get("voice", "mr-IN-AarohiNeural")
        self.rate = config.get("rate", "+0%")
        self._cache_dir = Path(config.get("cache_dir", "./logs/tts_cache"))
        self._cache_dir.mkdir(parents=True, exist_ok=True)

    async def _synthesize(self, text: str, output_path: Path) -> None:
        communicate = edge_tts.Communicate(
            text=text,
            voice=self.voice,
            rate=self.rate,
        )
        await communicate.save(str(output_path))

    def speak(self, text: str) -> bool:
        if not text or not text.strip():
            return True

        try:
            output_path = self._cache_dir / f"tts_{hash(text) % 1000000}.mp3"
            asyncio.run(self._synthesize(text, output_path))
            self._play_mp3(output_path)
            output_path.unlink(missing_ok=True)
            return True
        except Exception as e:
            logging.exception(f"TTS failed: {e}")
            print(f"TTS Error: {e}")
            return False

    def _play_mp3(self, file_path: Path) -> None:
        uri = file_path.resolve().as_uri()
        powershell_script = f"""
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
            ["powershell", "-NoProfile", "-Command", powershell_script],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=30,
        )

    def speak_async(self, text: str) -> None:
        import threading
        thread = threading.Thread(target=self.speak, args=(text,), daemon=True)
        thread.start()


class TTSMessages:
    def __init__(self, tts: TTSEngine):
        self.tts = tts

    def party_confirmed(self, party_name: str) -> None:
        self.tts.speak(f"{party_name} निवडले. आता मालाचे नाव बोला.")

    def item_confirmed(self, item_name: str, rate: float) -> None:
        self.tts.speak(f"{item_name} निवडले. दर {rate:,.2f} रुपये. नग बोला.")

    def line_summary(self, item_name: str, qty: float, rate: float, amount: float) -> None:
        self.tts.speak(
            f"{item_name} {qty:g} नग दर {rate:,.2f} रक्कम {amount:,.2f} रुपये. "
            "बरोबर असल्यास हो म्हणा."
        )

    def item_added(self) -> None:
        self.tts.speak("आइटम जोडले. पुढचे मालाचे नाव बोला किंवा बिल बनव म्हणा.")

    def final_summary(self, party: str, items_summary: str, total: float) -> None:
        self.tts.speak(
            f"ग्राहक: {party}. {items_summary}. एकूण रक्कम {total:,.2f} रुपये. "
            "बिल सेव्ह करायचा असल्यास हो म्हणा."
        )

    def bill_created(self, voucher_no: str) -> None:
        self.tts.speak(f"बिल तयार झाला. व्हाउचर नंबर {voucher_no}.")

    def bill_failed(self, error: str) -> None:
        self.tts.speak(f"बिल सेव्ह करताना त्रुटी: {error}.")

    def not_found(self, label: str) -> None:
        self.tts.speak(f"{label} जुळले नाही. पूर्ण नाव पुन्हा बोला.")

    def ambiguous(self, label: str, choices: str) -> None:
        self.tts.speak(f"{label} साठी एकापेक्षा जास्त नावे आहेत: {choices}. पूर्ण नाव बोला.")

    def inquiry_balance(self, name: str, amount: float) -> None:
        if amount < 0:
            self.tts.speak(f"{name} यांच्याकडून घ्यायची बाकी {abs(amount):,.2f} रुपये आहे.")
        elif amount > 0:
            self.tts.speak(f"{name} यांच्या खात्यावर जमा {amount:,.2f} रुपये आहे.")
        else:
            self.tts.speak(f"{name} यांची बाकी शून्य आहे.")

    def inquiry_stock(self, name: str, qty: float, unit: str) -> None:
        self.tts.speak(f"{name} चा स्टॉक {qty:g} {unit} आहे.")

    def listening(self) -> None:
        self.tts.speak("ऐकत आहे.")

    def not_understood(self) -> None:
        self.tts.speak("मला समजले नाही. कृपया पुन्हा बोला.")

    def session_cancelled(self) -> None:
        self.tts.speak("सत्र रद्द केले. टॅली मध्ये काहीही सेव्ह झालेले नाही.")

    def wake_detected(self) -> None:
        self.tts.speak("टॅली सुरू.")

    def no_speech(self) -> None:
        self.tts.speak("आवाज ऐकली नाही. पुन्हा बोला.")

    def quantity_prompt(self) -> None:
        self.tts.speak("नग बोला.")

    def rate_fetched(self, rate: float) -> None:
        self.tts.speak(f"दर {rate:,.2f} रुपये आढळला.")