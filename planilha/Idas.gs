/**
 * Planilha de idas aos condomínios — Alpha Condomínios
 * Busca TODAS as idas registradas pela IA (grupo, verificação, lançadas à mão e pela lista)
 * e mantém a aba "Idas" atualizada a cada 10 minutos.
 *
 * Como instalar (uma vez só):
 *  1. Crie uma planilha nova no Google Planilhas.
 *  2. Menu Extensões → Apps Script. Apague o que estiver lá e cole este arquivo inteiro.
 *  3. No grupo 🤖 Sugestões mande !planilha e cole o link que vier em URL_IDAS abaixo.
 *  4. Salve (ícone de disquete), volte para a planilha e recarregue a página.
 *  5. Menu Alpha → "Ligar atualização automática" (o Google pede autorização na 1ª vez).
 *
 * A coluna "Observação" é sua: o que você escrever nela é mantido nas atualizações.
 * Para filtrar sem atrapalhar a atualização, use Dados → "Criar visualização com filtro"
 * (ex.: um condomínio e um período, para apresentar na assembleia).
 */

const URL_IDAS = 'COLE_AQUI_O_LINK_DO_!planilha';

const ABA = 'Idas';
const ABA_RESUMO = 'Resumo';
const CAB = ['ID', 'Data', 'Dia', 'Semana (início)', 'Mês', 'Condomínio', 'Responsável (quadro)', 'Quem foi',
  'Tipo', 'Motivo / causa', 'Entrada', 'Saída', 'Saída estimada', 'Duração', 'Origem', 'Mensagem de entrada', 'Observação'];
const COL_OBS = CAB.length; // última coluna

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Alpha')
    .addItem('Atualizar idas agora', 'atualizarIdas')
    .addItem('Ligar atualização automática (a cada 10 min)', 'instalarGatilho')
    .addToUi();
}

function instalarGatilho() {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'atualizarIdas')
    .forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('atualizarIdas').timeBased().everyMinutes(10).create();
  atualizarIdas();
  SpreadsheetApp.getActive().toast('Atualização automática ligada (a cada 10 min).', 'Alpha');
}

function atualizarIdas() {
  if (URL_IDAS.indexOf('http') !== 0) throw new Error('Cole em URL_IDAS o link que o !planilha mandou.');
  const res = UrlFetchApp.fetch(URL_IDAS, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('O servidor respondeu ' + res.getResponseCode() + '. Confira o link (!planilha).');
  const idas = JSON.parse(res.getContentText()).idas || [];

  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(ABA) || ss.insertSheet(ABA, 0);

  // guarda as observações digitadas à mão, pelo ID
  const obs = {};
  const ultima = sh.getLastRow();
  if (ultima > 1) {
    sh.getRange(2, 1, ultima - 1, COL_OBS).getValues().forEach((r) => { if (r[0] && r[COL_OBS - 1]) obs[r[0]] = r[COL_OBS - 1]; });
  }

  // guarda o filtro simples (se houver) para reaplicar depois
  const criterios = {};
  const filtro = sh.getFilter();
  if (filtro) {
    for (let c = 1; c <= COL_OBS; c++) { const k = filtro.getColumnFilterCriteria(c); if (k) criterios[c] = k.copy().build(); }
    filtro.remove();
  }

  const data = (s) => { if (!s) return ''; const p = s.split('/').map(Number); return new Date(p[2], p[1] - 1, p[0]); };
  const linhas = idas.map((v) => [v.id, data(v.data), v.dia, data(v.semana), v.mes, v.condominio, v.responsavel, v.quem,
    v.tipo, v.motivo, v.entrada, v.saida, v.saida_estimada, v.duracao, v.origem, v.evidencia, obs[v.id] || '']);

  sh.clearContents();
  sh.getRange(1, 1, 1, COL_OBS).setValues([CAB]).setFontWeight('bold').setBackground('#1f3864').setFontColor('#ffffff');
  if (linhas.length) {
    sh.getRange(2, 11, linhas.length, 2).setNumberFormat('@'); // Entrada/Saída como texto (09:10)
    sh.getRange(2, 14, linhas.length, 1).setNumberFormat('@'); // Duração (0:52)
    sh.getRange(2, 1, linhas.length, COL_OBS).setValues(linhas);
    sh.getRange(2, 2, linhas.length, 1).setNumberFormat('dd/mm/yyyy');
    sh.getRange(2, 4, linhas.length, 1).setNumberFormat('dd/mm/yyyy');
  }
  sh.setFrozenRows(1);
  const novo = sh.getRange(1, 1, Math.max(linhas.length + 1, 2), COL_OBS).createFilter();
  Object.keys(criterios).forEach((c) => novo.setColumnFilterCriteria(Number(c), criterios[c]));
  sh.getRange('A1').setNote('Atualizado em ' + Utilities.formatDate(new Date(), 'America/Sao_Paulo', 'dd/MM/yyyy HH:mm'));

  if (!ss.getSheetByName(ABA_RESUMO)) criarResumo(ss);
}

// Resumo por condomínio (fórmula: atualiza sozinho junto com a aba Idas)
function criarResumo(ss) {
  const r = ss.insertSheet(ABA_RESUMO);
  r.getRange('A1').setFormula(
    "=QUERY(" + ABA + "!A1:Q, \"select F, G, count(A), max(B) where A is not null group by F, G order by F " +
    "label F 'Condomínio', G 'Responsável', count(A) 'Idas (total)', max(B) 'Última ida'\", 1)");
  r.getRange('D:D').setNumberFormat('dd/mm/yyyy');
  r.getRange('A1:D1').setFontWeight('bold');
  r.setFrozenRows(1);
}
