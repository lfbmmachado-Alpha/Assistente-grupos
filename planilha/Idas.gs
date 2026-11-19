/**
 * Planilha de idas aos condomínios — Alpha Administradora
 * Busca TODAS as idas registradas pela IA (grupo, verificação, lançadas à mão e pela lista),
 * mantém a aba "Idas" atualizada a cada 10 minutos e monta sozinha o layout:
 *   • Assembleia — escolha o condomínio e o período: relatório pronto para imprimir/apresentar
 *   • Idas       — todas as idas, com filtro (a coluna Observação é sua e é mantida)
 *   • Resumo     — por condomínio: vistorias, idas extras, total e última ida
 *
 * Como instalar (uma vez só):
 *  1. Crie uma planilha nova no Google Planilhas.
 *  2. Menu Extensões → Apps Script. Apague o que estiver lá e cole este arquivo inteiro.
 *  3. No grupo 🤖 Sugestões mande !planilha e cole o link que vier em URL_IDAS abaixo.
 *  4. Salve (ícone de disquete), volte para a planilha e recarregue a página.
 *  5. Menu Alpha → "Ligar atualização automática" (o Google pede autorização na 1ª vez).
 */

const URL_IDAS = 'COLE_AQUI_O_LINK_DO_!planilha';

// Só se o script for criado FORA da planilha (em script.google.com → Novo projeto):
// cole aqui o ID da planilha (o trecho entre /d/ e /edit no endereço dela). Dentro da planilha, deixe vazio.
const ID_PLANILHA = '';

function planilha() {
  return ID_PLANILHA ? SpreadsheetApp.openById(ID_PLANILHA) : SpreadsheetApp.getActive();
}

const ABA = 'Idas';
const ABA_RESUMO = 'Resumo';
const ABA_ASSEMBLEIA = 'Assembleia';
const ABA_LEITURAS = 'Leituras';
const CAB = ['ID', 'Data', 'Dia', 'Semana (início)', 'Mês', 'Condomínio', 'Responsável (quadro)', 'Quem foi',
  'Tipo', 'Motivo / causa', 'Entrada', 'Saída', 'Saída estimada', 'Duração', 'Origem', 'Mensagem de entrada', 'Observação'];
const LARG = [45, 85, 45, 95, 70, 190, 120, 100, 135, 230, 65, 65, 75, 70, 120, 260, 260];
const COL_OBS = CAB.length; // última coluna

// cores da Alpha
const AZUL = '#1f3864', AZUL_CLARO = '#dbe5f1', VERDE = '#e2f0d9', LARANJA = '#fce4d6', CINZA = '#f2f2f2';

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Alpha')
    .addItem('Atualizar idas agora', 'atualizarIdas')
    .addItem('Ligar atualização automática (a cada 10 min)', 'instalarGatilho')
    .addSeparator()
    .addItem('Refazer layout', 'refazerLayout')
    .addToUi();
}

function instalarGatilho() {
  ScriptApp.getProjectTriggers()
    .filter((t) => ['atualizarIdas', 'aoEditar'].indexOf(t.getHandlerFunction()) >= 0)
    .forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('atualizarIdas').timeBased().everyMinutes(10).create();
  // troca de responsável na aba Leituras vai para o sistema na hora
  ScriptApp.newTrigger('aoEditar').forSpreadsheet(planilha()).onEdit().create();
  atualizarIdas();
  try { planilha().toast('Atualização automática ligada (a cada 10 min).', 'Alpha'); } catch (e) {}
}

function refazerLayout() {
  const ss = planilha();
  [ABA_ASSEMBLEIA, ABA_RESUMO].forEach((n) => { const s = ss.getSheetByName(n); if (s) ss.deleteSheet(s); });
  atualizarIdas();
}

// ---------------------------------------------------------------- dados
function atualizarIdas() {
  if (URL_IDAS.indexOf('http') !== 0) throw new Error('Cole em URL_IDAS o link que o !planilha mandou.');
  const res = UrlFetchApp.fetch(URL_IDAS, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('O servidor respondeu ' + res.getResponseCode() + '. Confira o link (!planilha).');
  const dados = JSON.parse(res.getContentText());
  const idas = dados.idas || [];

  const ss = planilha();
  let sh = ss.getSheetByName(ABA);
  const nova = !sh;
  if (!sh) {
    sh = ss.getSheetByName('Página1') || ss.getSheetByName('Sheet1') || ss.insertSheet(ABA);
    sh.setName(ABA);
  }

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
  // mais recentes primeiro
  const linhas = idas.map((v) => [v.id, data(v.data), v.dia, data(v.semana), v.mes, v.condominio, v.responsavel, v.quem,
    v.tipo, v.motivo, v.entrada, v.saida, v.saida_estimada, v.duracao, v.origem, v.evidencia, obs[v.id] || ''])
    .sort((a, b) => (b[1] - a[1]) || (String(b[10]).localeCompare(String(a[10]))));

  sh.clearContents();
  sh.getRange(1, 1, 1, COL_OBS).setValues([CAB]);
  if (linhas.length) {
    sh.getRange(2, 11, linhas.length, 2).setNumberFormat('@'); // Entrada/Saída como texto (09:10)
    sh.getRange(2, 14, linhas.length, 1).setNumberFormat('@'); // Duração (0:52)
    sh.getRange(2, 1, linhas.length, COL_OBS).setValues(linhas);
  }
  layoutIdas(sh, linhas.length, nova);
  const novo = sh.getRange(1, 1, Math.max(linhas.length + 1, 2), COL_OBS).createFilter();
  Object.keys(criterios).forEach((c) => novo.setColumnFilterCriteria(Number(c), criterios[c]));
  const quando = Utilities.formatDate(new Date(), 'America/Sao_Paulo', 'dd/MM/yyyy HH:mm');
  sh.getRange('A1').setNote('Atualizado em ' + quando);

  if (dados.leituras) escreverLeituras(ss, dados.leituras);
  if (!ss.getSheetByName(ABA_RESUMO)) criarResumo(ss);
  if (!ss.getSheetByName(ABA_ASSEMBLEIA)) criarAssembleia(ss);
  ss.getSheetByName(ABA_ASSEMBLEIA).getRange('H2').setValue('Atualizado em ' + quando);
}

// ---------------------------------------------------------------- aba Idas
function layoutIdas(sh, n, primeiraVez) {
  const lin = Math.max(n, 1);
  sh.setFrozenRows(1);
  sh.setFrozenColumns(0);
  sh.getRange(1, 1, 1, COL_OBS).setFontWeight('bold').setBackground(AZUL).setFontColor('#ffffff')
    .setVerticalAlignment('middle').setHorizontalAlignment('center').setWrap(true);
  sh.setRowHeight(1, 36);
  sh.getRange(2, 1, lin, COL_OBS).setFontSize(10).setVerticalAlignment('middle').setWrap(false).setFontWeight('normal');
  sh.getRange(2, 2, lin, 1).setNumberFormat('dd/mm/yyyy');
  sh.getRange(2, 4, lin, 1).setNumberFormat('dd/mm/yyyy');
  [1, 2, 3, 4, 5, 11, 12, 13, 14].forEach((c) => sh.getRange(2, c, lin, 1).setHorizontalAlignment('center'));
  sh.getRange(2, 6, lin, 1).setFontWeight('bold');
  sh.getRange(2, 1, lin, 1).setFontColor('#999999');
  sh.getRange(2, 16, lin, 1).setFontColor('#666666').setFontStyle('italic');
  sh.getRange(2, COL_OBS, lin, 1).setBackground('#fff9e6'); // coluna para você escrever

  if (primeiraVez) {
    LARG.forEach((w, i) => sh.setColumnWidth(i + 1, w));
    sh.hideColumns(1);   // ID (usado só para manter as observações)
    sh.hideColumns(4);   // Semana (início) — continua disponível no filtro ao reexibir
    sh.hideColumns(16);  // Mensagem de entrada
  }

  // cores por tipo e saída estimada (regras refeitas a cada atualização)
  const area = sh.getRange(2, 1, Math.max(n, 1) + 500, COL_OBS);
  const tipo = sh.getRange(2, 9, Math.max(n, 1) + 500, 1);
  const est = sh.getRange(2, 12, Math.max(n, 1) + 500, 1);
  sh.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Vistoria da semana').setBackground(VERDE).setFontColor('#2e6b1f').setRanges([tipo]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Ida extra').setBackground(LARANJA).setFontColor('#9c4a0f').setRanges([tipo]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=$M2="Sim"').setFontColor('#999999').setItalic(true).setRanges([est]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=AND($A2<>"",ISEVEN(ROW()))').setBackground(CINZA).setRanges([area]).build(),
  ]);
}

// ---------------------------------------------------------------- aba Resumo
function criarResumo(ss) {
  const r = ss.insertSheet(ABA_RESUMO);
  r.getRange('A1').setValue('Resumo por condomínio').setFontSize(14).setFontWeight('bold').setFontColor(AZUL);
  r.getRange('A2').setValue('Total de idas registradas desde o início. Para um período, use a aba Assembleia.').setFontColor('#666666');
  r.getRange('A4:F4').setValues([['Condomínio', 'Responsável', 'Vistorias', 'Idas extras', 'Total de idas', 'Última ida']])
    .setFontWeight('bold').setBackground(AZUL).setFontColor('#ffffff').setHorizontalAlignment('center');
  formula(r.getRange('A5'), '=IFERROR(SORT(UNIQUE(FILTER({' + ABA + '!F2:F, ' + ABA + '!G2:G}, ' + ABA + '!F2:F<>""))), )');
  formula(r.getRange('C5'), '=ARRAYFORMULA(IF(A5:A="", , COUNTIFS(' + ABA + '!F2:F, A5:A, ' + ABA + '!I2:I, "Vistoria da semana")))');
  formula(r.getRange('D5'), '=ARRAYFORMULA(IF(A5:A="", , COUNTIFS(' + ABA + '!F2:F, A5:A, ' + ABA + '!I2:I, "Ida extra")))');
  formula(r.getRange('E5'), '=ARRAYFORMULA(IF(A5:A="", , C5:C + D5:D))');
  // a aba Idas fica ordenada da mais recente para a mais antiga: a 1ª ocorrência é a última ida
  formula(r.getRange('F5'), '=ARRAYFORMULA(IF(A5:A="", , IFERROR(VLOOKUP(A5:A, {' + ABA + '!F2:F, ' + ABA + '!B2:B}, 2, FALSE))))');
  r.getRange('F5:F').setNumberFormat('dd/mm/yyyy');
  r.getRange('C5:F').setHorizontalAlignment('center');
  r.getRange('A5:A').setFontWeight('bold');
  [220, 130, 90, 100, 110, 110].forEach((w, i) => r.setColumnWidth(i + 1, w));
  r.setFrozenRows(4);
  r.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=AND($A5<>"",ISEVEN(ROW()))').setBackground(CINZA).setRanges([r.getRange('A5:F')]).build(),
  ]);
}

// ---------------------------------------------------------------- aba Assembleia
function criarAssembleia(ss) {
  const a = ss.insertSheet(ABA_ASSEMBLEIA, 0);
  a.setHiddenGridlines(true);
  [110, 50, 110, 125, 230, 70, 70, 75, 220].forEach((w, i) => a.setColumnWidth(i + 1, w));

  a.getRange('A1:I1').merge().setValue('RELATÓRIO DE VISITAS AO CONDOMÍNIO')
    .setFontSize(16).setFontWeight('bold').setFontColor('#ffffff').setBackground(AZUL).setHorizontalAlignment('center').setVerticalAlignment('middle');
  a.setRowHeight(1, 42);
  a.getRange('A2:G2').merge().setValue('Alpha Administradora').setFontColor(AZUL).setFontWeight('bold');
  a.getRange('H2:I2').merge().setHorizontalAlignment('right').setFontColor('#999999').setFontSize(9);

  // filtros (células amarelas)
  a.getRange('A4:A6').setValues([['Condomínio'], ['De'], ['Até']]).setFontWeight('bold').setHorizontalAlignment('right');
  a.getRange('B4:E4').merge();
  a.getRange('B5:C5').merge();
  a.getRange('B6:C6').merge();
  const hoje = new Date();
  a.getRange('B5').setValue(new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1)).setNumberFormat('dd/mm/yyyy');
  a.getRange('B6').setValue(new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate())).setNumberFormat('dd/mm/yyyy');
  a.getRange('B4:E6').setBackground('#fff2cc').setFontWeight('bold').setHorizontalAlignment('left')
    .setBorder(true, true, true, true, true, true, '#d6b656', SpreadsheetApp.BorderStyle.SOLID);
  a.getRange('B4').setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInRange(ss.getSheetByName(ABA_RESUMO).getRange('A5:A'), true).setAllowInvalid(false).build());
  a.getRange('B5:B6').setDataValidation(SpreadsheetApp.newDataValidation().requireDate().setAllowInvalid(false).build());
  a.getRange('G4:I4').merge().setValue('◀ escolha o condomínio e o período').setFontColor('#999999').setFontStyle('italic');

  // indicadores
  const cond = ABA + '!F2:F, $B$4, ' + ABA + '!B2:B, ">="&$B$5, ' + ABA + '!B2:B, "<="&$B$6';
  a.getRange('A8:I8').setValues([['Vistorias', '', 'Idas extras', 'Total de idas', 'Tempo no condomínio', '', '', '', '']]);
  formula(a.getRange('A9'), '=IF($B$4="", "", COUNTIFS(' + cond + ', ' + ABA + '!I2:I, "Vistoria da semana"))');
  formula(a.getRange('C9'), '=IF($B$4="", "", COUNTIFS(' + cond + ', ' + ABA + '!I2:I, "Ida extra"))');
  formula(a.getRange('D9'), '=IF($B$4="", "", A9 + C9)');
  formula(a.getRange('E9'), '=IF($B$4="", "", IFERROR(TEXT(SUMPRODUCT((' + ABA + '!F2:F=$B$4)*(' + ABA + '!B2:B>=$B$5)*(' + ABA + '!B2:B<=$B$6)*IFERROR(TIMEVALUE(' + ABA + '!N2:N&":00"), 0)), "[h]:mm") & " h", "-"))');
  a.getRange('A8:B8').merge(); a.getRange('A9:B9').merge();
  a.getRange('A8:E8').setFontColor('#666666').setFontSize(9).setHorizontalAlignment('center');
  a.getRange('A9:E9').setFontSize(20).setFontWeight('bold').setFontColor(AZUL).setHorizontalAlignment('center');
  a.getRange('A8:E9').setBackground(AZUL_CLARO);
  a.setRowHeight(9, 38);

  // tabela de idas do período
  a.getRange('A11:I11').setValues([['Data', 'Dia', 'Quem foi', 'Tipo', 'Motivo / causa', 'Entrada', 'Saída', 'Duração', 'Observação']])
    .setFontWeight('bold').setBackground(AZUL).setFontColor('#ffffff').setHorizontalAlignment('center');
  const col = (c) => ABA + '!' + c + '2:' + c;
  formula(a.getRange('A12'), '=IF($B$4="", "Escolha o condomínio em B4", IFERROR(SORT(FILTER({' +
    ['B', 'C', 'H', 'I', 'J', 'K', 'L', 'N', 'Q'].map(col).join(', ') + '}, ' +
    col('F') + '=$B$4, ' + col('B') + '>=$B$5, ' + col('B') + '<=$B$6), 1, TRUE), "Nenhuma ida registrada no período."))');
  a.getRange('A12:A').setNumberFormat('dd/mm/yyyy');
  a.getRange('A12:H').setHorizontalAlignment('center');
  a.getRange('E12:E').setHorizontalAlignment('left').setWrap(true);
  a.getRange('I12:I').setHorizontalAlignment('left').setWrap(true);
  a.setFrozenRows(11);
  a.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Vistoria da semana').setBackground(VERDE).setFontColor('#2e6b1f').setRanges([a.getRange('D12:D')]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Ida extra').setBackground(LARANJA).setFontColor('#9c4a0f').setRanges([a.getRange('D12:D')]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=AND($C12<>"",ISEVEN(ROW()))').setBackground(CINZA).setRanges([a.getRange('A12:I')]).build(),
  ]);
  // primeiro condomínio da lista já selecionado, para não abrir vazio
  SpreadsheetApp.flush();
  const primeiro = String(ss.getSheetByName(ABA_RESUMO).getRange('A5').getDisplayValue() || '');
  if (primeiro && primeiro.charAt(0) !== '#') a.getRange('B4').setValue(primeiro);
  try { a.activate(); } catch (e) {}
}

// ---------------------------------------------------------------- fórmulas e idioma da planilha
// Planilha em português usa ";" entre argumentos e "\\" entre colunas de { }. Escreve a fórmula no padrão
// americano e, se a planilha acusar erro, troca os separadores.
function formula(range, f) {
  range.setFormula(f);
  SpreadsheetApp.flush();
  if (String(range.getDisplayValue()).indexOf('#ERROR') === 0) range.setFormula(paraPtBr(f));
  return range;
}
function paraPtBr(f) {
  let out = '', aspas = false, chaves = 0;
  for (const ch of f) {
    if (ch === '"') aspas = !aspas;
    if (!aspas && ch === '{') chaves++;
    if (!aspas && ch === '}') chaves--;
    out += !aspas && ch === ',' ? (chaves > 0 ? '\\' : ';') : ch;
  }
  return out;
}

// ---------------------------------------------------------------- aba Leituras
// Um mês por coluna, lado a lado (o mais novo à direita). O histórico vem do sistema e nunca é apagado.
function escreverLeituras(ss, L) {
  let sh = ss.getSheetByName(ABA_LEITURAS);
  const nova = !sh;
  if (!sh) sh = ss.insertSheet(ABA_LEITURAS);
  const fixas = ['Condomínio', 'Responsável', 'Última leitura', 'Próxima', 'Situação'];
  const cab = fixas.concat(L.meses.map((m) => 'Leitura ' + m));
  const linhas = L.linhas.map((r) => [r.condominio, r.responsavel, r.ultima, r.proxima, r.situacao].concat(r.meses));
  const nc = cab.length;
  if (sh.getFilter()) sh.getFilter().remove();
  sh.clearContents();
  sh.getRange(1, 1, Math.max(linhas.length + 1, 2), nc).setNumberFormat('@');
  sh.getRange(1, 1, 1, nc).setValues([cab]).setFontWeight('bold').setBackground(AZUL).setFontColor('#ffffff')
    .setHorizontalAlignment('center').setVerticalAlignment('middle').setWrap(true);
  sh.setRowHeight(1, 36);
  if (linhas.length) {
    sh.getRange(2, 1, linhas.length, nc).setValues(linhas).setFontSize(10).setVerticalAlignment('middle');
    sh.getRange(2, 1, linhas.length, 1).setFontWeight('bold');
    sh.getRange(2, 3, linhas.length, nc - 2).setHorizontalAlignment('center');
  }
  sh.setFrozenRows(1);
  sh.setFrozenColumns(2);
  if (nova) { sh.setColumnWidth(1, 210); sh.setColumnWidth(2, 110); sh.setColumnWidth(3, 100); sh.setColumnWidth(4, 100); sh.setColumnWidth(5, 120); }
  for (let c = 6; c <= nc; c++) sh.setColumnWidth(c, 115);
  sh.getRange(1, 1, Math.max(linhas.length + 1, 2), nc).createFilter();
  const sit = sh.getRange(2, 5, Math.max(linhas.length, 1), 1);
  const ultimoMes = nc > 5 ? sh.getRange(2, nc, Math.max(linhas.length, 1), 1) : null;
  const regras = [
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Atrasada').setBackground('#f4cccc').setFontColor('#990000').setBold(true).setRanges([sit]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Nesta semana').setBackground('#fff2cc').setFontColor('#7f6000').setRanges([sit]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Feita na semana').setBackground(VERDE).setFontColor('#2e6b1f').setRanges([sit]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=ISEVEN(ROW())').setBackground(CINZA).setRanges([sh.getRange(2, 1, Math.max(linhas.length, 1), nc)]).build(),
  ];
  if (ultimoMes) regras.unshift(SpreadsheetApp.newConditionalFormatRule().whenCellNotEmpty().setBackground(AZUL_CLARO).setRanges([ultimoMes]).build());
  sh.setConditionalFormatRules(regras);
}

// ---------------------------------------------------------------- edição do responsável (aba Leituras)
// Ao mudar a coluna "Responsável", o sistema passa a cobrar a leitura dessa pessoa a partir do próximo aviso.
function aoEditar(e) {
  try {
    const sh = e.range.getSheet();
    if (sh.getName() !== ABA_LEITURAS || e.range.getColumn() !== 2 || e.range.getRow() < 2) return;
    const linhas = e.range.getNumRows();
    for (let i = 0; i < linhas; i++) {
      const r = e.range.getRow() + i;
      const condominio = sh.getRange(r, 1).getValue();
      const responsavel = String(sh.getRange(r, 2).getValue() || '').trim();
      if (!condominio || !responsavel) continue;
      const url = URL_IDAS.replace('/api/idas/', '/api/leituras/') + '/responsavel';
      const res = UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json', muteHttpExceptions: true,
        payload: JSON.stringify({ condominio: condominio, responsavel: responsavel }) });
      const ok = res.getResponseCode() === 200;
      sh.getRange(r, 2).setNote(ok ? 'Responsável atualizado no sistema em ' + Utilities.formatDate(new Date(), 'America/Sao_Paulo', 'dd/MM HH:mm')
        : 'Não consegui atualizar no sistema (' + res.getResponseCode() + ')');
    }
  } catch (err) { console.error(err); }
}
