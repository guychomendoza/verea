"""
Verea's account emails (Spanish), sent through Resend from no-reply@verea.app: Supabase fills in
{{ .ConfirmationURL }} and {{ .Email }}. scripts/supabase_setup.py uploads them with --resend.
"""

LOGO = "https://tiles.verea.app/email-logo.png"   # frontend/public/email-logo.png, uploaded to the R2 bucket
NAVY, TEAL, INK, MUTED, LINE = "#193352", "#3da3bc", "#102136", "#5b6c80", "#e1e7ee"

# key: (subject, heading, text, button)
EMAILS = {
    "recovery": ("Restablece tu contraseña de Verea", "Restablece tu contraseña",
                 "Recibimos una solicitud para cambiar la contraseña de {{ .Email }}. "
                 "Si fuiste tú, elige una nueva con el botón. Si no, ignora este correo: tu contraseña no cambia.",
                 "Elegir una contraseña nueva"),
    "invite": ("Te invitaron a Verea", "Te damos la bienvenida a Verea",
               "Te invitaron a planear redes IoT para el campo con el equipo. Crea tu contraseña para entrar.",
               "Crear mi contraseña"),
    "confirmation": ("Confirma tu correo en Verea", "Confirma tu correo",
                     "Confirma que {{ .Email }} es tu correo para terminar de crear tu cuenta de Verea.",
                     "Confirmar mi correo"),
    "magic_link": ("Tu enlace para entrar a Verea", "Entra a Verea",
                   "Usa este enlace para entrar a Verea. Vence en una hora y solo sirve una vez.",
                   "Entrar"),
    "email_change": ("Confirma tu nuevo correo en Verea", "Confirma tu nuevo correo",
                     "Pediste usar {{ .Email }} como tu correo en Verea. Confírmalo con el botón.",
                     "Confirmar el cambio"),
}


def html(heading: str, text: str, button: str) -> str:
    """One email: logo, heading, text, a button and the link written out (some clients hide buttons)."""
    return f"""<!doctype html>
<html lang="es"><body style="margin:0;padding:0;background:#eef2f6;font-family:Arial,Helvetica,sans-serif;color:{INK}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef2f6;padding:32px 12px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:16px;border:1px solid {LINE}">
<tr><td align="center" style="padding:28px 28px 8px"><img src="{LOGO}" width="120" alt="Verea" style="display:block;border:0"></td></tr>
<tr><td style="padding:8px 32px 0;text-align:center">
<h1 style="margin:0 0 12px;font-size:22px;color:{NAVY}">{heading}</h1>
<p style="margin:0 0 24px;font-size:15px;line-height:1.5;color:{INK}">{text}</p>
<a href="{{{{ .ConfirmationURL }}}}" style="display:inline-block;background:{NAVY};color:#ffffff;text-decoration:none;font-weight:bold;font-size:15px;padding:12px 24px;border-radius:10px">{button}</a>
<p style="margin:24px 0 0;font-size:12px;line-height:1.5;color:{MUTED}">Si el botón no funciona, copia este enlace en tu navegador:<br>
<a href="{{{{ .ConfirmationURL }}}}" style="color:{TEAL};word-break:break-all">{{{{ .ConfirmationURL }}}}</a></p>
</td></tr>
<tr><td style="padding:24px 32px 28px;text-align:center;font-size:12px;color:{MUTED};border-top:1px solid {LINE}">
Verea · Planeación de redes IoT para el campo<br>Este correo se envió automáticamente; no lo respondas.
</td></tr>
</table></td></tr></table></body></html>"""


def auth_config() -> dict:
    """The subjects and bodies as Supabase's auth config fields."""
    out = {}
    for key, (subject, heading, text, button) in EMAILS.items():
        out[f"mailer_subjects_{key}"] = subject
        out[f"mailer_templates_{key}_content"] = html(heading, text, button)
    return out
