// Suelen → Google Agenda do Rafael
// Cola isto em script.google.com (logado na conta Google do Rafael) e publica como "App da Web".
const SEGREDO = "f6e386cffa84edb7";

function doPost(e) {
  try {
    const d = JSON.parse(e.postData.contents);
    if (d.segredo !== SEGREDO) return resposta({ ok: false, erro: "segredo" });
    const ev = CalendarApp.getDefaultCalendar().createEvent(
      d.titulo,
      new Date(d.inicio + ":00-03:00"),
      new Date(d.fim + ":00-03:00"),
      { location: d.local || "", description: d.descricao || "" }
    );
    ev.removeAllReminders();
    ev.addPopupReminder(24 * 60); // 1 dia antes
    ev.addPopupReminder(60);      // 1 hora antes
    return resposta({ ok: true, id: ev.getId() });
  } catch (err) {
    return resposta({ ok: false, erro: String(err) });
  }
}

function resposta(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

// Rode esta função uma vez pelo editor pra autorizar o acesso à agenda.
function testar() {
  CalendarApp.getDefaultCalendar().createEvent("Teste Suelen", new Date(Date.now() + 3600000), new Date(Date.now() + 7200000)).deleteEvent();
}
