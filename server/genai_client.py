import os

from google import genai


def get_client() -> genai.Client:
    return genai.Client(api_key=os.environ["GEMINI_API_KEY"])
