import emails
import os
from typing import Optional

from starlette.config import Config


class EmailSender:
    def __init__(self, smtp_server: str, sender_email: str, password: str):
        self.smtp_server = smtp_server
        self.sender_email = sender_email
        self.password = password

    def send_email(self, recipient: str, subject: str, text: str) -> Optional[bool]:
        try:
            # Modification ici : on utilise directement sender_email au lieu de "Test"
            message = emails.Message(
                subject=subject,
                text=text,
                mail_from=self.sender_email  # Changement ici
            )

            response = message.send(
                to=recipient,
                smtp={
                    "host": self.smtp_server,
                    "port": 587,
                    "ssl": False,
                    "tls": True,
                    "user": self.sender_email,
                    "password": self.password,
                    "debug": 0
                }
            )

            #print(f"Code de réponse: {response.status_code}")
            #print(f"Message du serveur: {response.error}")
            return response.status_code == 250

        except Exception as e:
            print(f"Erreur détaillée: {str(e)}")
            return False


def main():
    # Configuration
    config = Config('.env')
    smtp_server = "mail.quiaz.com"
    sender_email = config('EMAIL_USER', cast=str)

    password = config('EMAIL_PASSWORD', cast=str)

    # Ajout de vérifications
    if not sender_email or not password:
        print("Erreur: EMAIL_USER ou EMAIL_PASSWORD non définis dans le fichier .env")
        return

    recipient = "anthonygosme@gmail.com"

    sender = EmailSender(smtp_server, sender_email, password)
    sender.send_email(
        recipient=recipient,
        subject="Test Email",
        text="Hello World from Python!"
    )

if __name__ == "__main__":
    main()