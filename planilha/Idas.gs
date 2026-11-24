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

// Logo da Alpha para o relatório em PDF: cole o link do arquivo da logo no Google Drive (Compartilhar → Copiar link)
// ou um link direto da imagem (https://…png). Vazio: o relatório sai com o nome por extenso.
const LOGO = '';

// Liderança direta de cada responsável (aparece no relatório em PDF). Ajuste aqui quando mudar.
const LIDERANCA = {
  Leandro: 'Janaina',
  Samuel: 'Janaina',
  Carlos: 'Kesse',
  Kesse: 'Ederson',
  Nathan: 'Ederson',
  Janaina: 'Ederson',
};

function planilha() {
  return ID_PLANILHA ? SpreadsheetApp.openById(ID_PLANILHA) : SpreadsheetApp.getActive();
}

const ABA = 'Idas';
const ABA_RESUMO = 'Resumo';
const ABA_LISTAS = '_Listas';
const ABA_SEMANA = 'Vistorias da semana';
const ABA_PEND = 'Pendências'; // lista de condomínios para os menus de escolha (aba oculta)
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
    .addItem('📄 Relatório de idas do condomínio (PDF)', 'gerarRelatorioPDF')
    .addItem('📋 Relatório de vistorias da semana (PDF)', 'abrirRelatorioSemana')
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
  if (dados.pendencias) { try { escreverPendencias(ss, dados.pendencias); } catch (e) { console.error('pendências: ' + e.message); } }
  escreverListas(ss, linhas.map((l) => l[5]));
  const filtroPainel = escreverPainel(ss, dados.painel || {}, quando);
  if (!ss.getSheetByName(ABA_ASSEMBLEIA)) criarAssembleia(ss);
  ss.getSheetByName(ABA_ASSEMBLEIA).getRange('H2').setValue('Atualizado em ' + quando);
  try { escreverAbaSemana(ss); } catch (e) { console.error('aba semana: ' + e.message); }
  try { protegerAbas(ss, filtroPainel); } catch (e) { console.error('proteção: ' + e.message); }
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

// ---------------------------------------------------------------- lista de condomínios (aba oculta)
function escreverListas(ss, nomes) {
  let l = ss.getSheetByName(ABA_LISTAS);
  if (!l) { l = ss.insertSheet(ABA_LISTAS); l.hideSheet(); }
  const unicos = Array.from(new Set(nomes.filter(String))).sort((a, b) => a.localeCompare(b));
  l.clearContents();
  l.getRange(1, 1).setValue('Condomínios');
  if (unicos.length) l.getRange(2, 1, unicos.length, 1).setValues(unicos.map((n) => [n]));
}

// ---------------------------------------------------------------- aba Resumo (painel)
// Refeita a cada atualização. Só o filtro de condomínio (e o período) que você escolheu é mantido.
const FUNDO = '#f1f4f9', BRANCO = '#ffffff', TEXTO = '#1f2a44', SUAVE = '#7a869a', LINHA = '#e3e8f0';
const OK = '#2e7d32', ALERTA = '#f9a825', RUIM = '#c62828';
// colunas do painel: A e J são margens
const PC = { A: 1, NOME: 2, FEITAS: 3, TOTAL: 4, PCT: 5, BARRA: 6, EXTRA: 7, LISTA: 8, LISTA2: 9, J: 10 };
const LARG_PAINEL = [28, 200, 80, 80, 70, 170, 110, 300, 300, 28];

function escreverPainel(ss, P, quando) {
  let r = ss.getSheetByName(ABA_RESUMO);
  if (!r) r = ss.insertSheet(ABA_RESUMO, 0);
  // guarda a escolha do filtro (linha marcada com "Condomínio" na coluna B)
  let filtro = { condo: '', de: '', ate: '' };
  const usados = r.getLastRow();
  if (usados) {
    const colB = r.getRange(1, PC.NOME, usados, 1).getValues();
    for (let i = 0; i < colB.length; i++) {
      if (colB[i][0] === 'Condomínio') {
        filtro = { condo: r.getRange(i + 1, PC.FEITAS).getValue(), de: r.getRange(i + 2, PC.FEITAS).getValue(), ate: r.getRange(i + 3, PC.FEITAS).getValue() };
        break;
      }
    }
  }
  r.getCharts().forEach((c) => r.removeChart(c));
  r.getRange(1, 1, r.getMaxRows(), r.getMaxColumns()).breakApart();
  r.clear();
  r.getRange(1, 1, r.getMaxRows(), r.getMaxColumns()).setNumberFormat('General');
  r.clearConditionalFormatRules();
  r.getRange(1, 1, r.getMaxRows(), r.getMaxColumns()).clearDataValidations();
  if (r.getMaxColumns() < PC.J) r.insertColumnsAfter(r.getMaxColumns(), PC.J - r.getMaxColumns());
  if (r.getMaxColumns() > PC.J) r.deleteColumns(PC.J + 1, r.getMaxColumns() - PC.J);
  r.setHiddenGridlines(true);
  LARG_PAINEL.forEach((w, i) => r.setColumnWidth(i + 1, w));
  r.getRange(1, 1, r.getMaxRows(), PC.J).setBackground(FUNDO).setFontFamily('Roboto').setFontColor(TEXTO).setFontSize(10)
    .setVerticalAlignment('middle');

  const V = P.vistorias || { total: 0, feitas: 0, idas: 0, pessoas: [], semana: '' };
  const L = P.leituras || { total: 0, feitas: 0, pessoas: [], mes: '' };
  const atrasadas = (L.pessoas || []).reduce((t, p) => t + p.atrasadas.length, 0);
  const pct = (a, b) => (b ? a / b : 0);
  const corDe = (x) => (x >= 0.8 ? OK : x >= 0.5 ? ALERTA : RUIM);
  const pt = usarPortugues(ss);
  const F = (range, f) => range.setFormula(pt ? paraPtBr(f) : f);
  // barra de progresso só com números inteiros (feitas e total), para funcionar em planilha em português
  const barra = (f, t, cor) => '=SPARKLINE(' + Math.round(f) + ', {"charttype","bar";"max",' + Math.max(1, Math.round(t)) + ';"color1","' + cor + '";"color2","#e3e8f0";"empty","zero"})';

  // ---- cabeçalho
  r.setRowHeight(1, 14);
  r.getRange(2, PC.NOME, 1, PC.LISTA2 - 1).merge().setValue('Painel de Operações')
    .setFontFamily('Montserrat').setFontSize(20).setFontWeight('bold').setFontColor(BRANCO).setBackground(AZUL);
  r.getRange(3, PC.NOME, 1, PC.LISTA2 - 1).merge().setValue('Alpha Administradora  ·  vistorias da semana ' + V.semana + '  ·  leituras de ' + L.mes)
    .setFontSize(10).setFontColor('#c9d3e6').setBackground(AZUL);
  r.getRange(2, PC.NOME, 2, PC.LISTA2 - 1).setHorizontalAlignment('left');
  r.setRowHeight(2, 44); r.setRowHeight(3, 24);
  r.getRange(4, PC.NOME, 1, PC.LISTA2 - 1).merge().setValue('Atualizado em ' + quando + ' · atualiza sozinho a cada 10 minutos')
    .setFontSize(8).setFontColor(SUAVE).setHorizontalAlignment('right');

  // ---- cartões
  const cartao = (c1, c2, titulo, valor, sub, cor) => {
    const n = c2 - c1 + 1;
    r.getRange(6, c1, 1, n).merge().setValue(titulo).setFontSize(8).setFontWeight('bold').setFontColor(SUAVE);
    r.getRange(7, c1, 1, n).merge().setValue(valor).setFontSize(24).setFontWeight('bold').setFontColor(cor).setFontFamily('Montserrat');
    r.getRange(8, c1, 1, n).merge().setValue(sub).setFontSize(9).setFontColor(SUAVE);
    r.getRange(6, c1, 3, n).setBackground(BRANCO).setHorizontalAlignment('left')
      .setBorder(true, true, true, true, null, null, LINHA, SpreadsheetApp.BorderStyle.SOLID);
    r.getRange(6, c1, 3, 1).setBorder(null, true, null, null, null, null, cor, SpreadsheetApp.BorderStyle.SOLID_THICK);
  };
  const pv = pct(V.feitas, V.total), pl = pct(L.feitas, L.total);
  cartao(PC.NOME, PC.NOME, '  VISTORIAS DA SEMANA', '  ' + V.feitas + ' / ' + V.total, '  ' + Math.round(pv * 100) + '% concluído', corDe(pv));
  cartao(PC.FEITAS, PC.PCT, '  IDAS NA SEMANA', '  ' + (V.idas || 0), '  vistorias + idas extras', AZUL);
  cartao(PC.BARRA, PC.EXTRA, '  LEITURAS DO MÊS', '  ' + L.feitas + ' / ' + L.total, '  ' + Math.round(pl * 100) + '% concluído', corDe(pl));
  cartao(PC.LISTA, PC.LISTA, '  LEITURAS ATRASADAS', '  ' + atrasadas, atrasadas ? '  precisam de atenção' : '  nenhuma 🎉', atrasadas ? RUIM : OK);
  cartao(PC.LISTA2, PC.LISTA2, '  PENDENTES NA SEMANA', '  ' + (V.total - V.feitas), '  condomínios sem vistoria', (V.total - V.feitas) ? ALERTA : OK);
  r.setRowHeight(6, 22); r.setRowHeight(7, 40); r.setRowHeight(8, 22);

  let lin = 10;
  const secao = (titulo, sub) => {
    r.getRange(lin, PC.NOME, 1, PC.LISTA2 - 1).merge()
      .setRichTextValue(SpreadsheetApp.newRichTextValue().setText(titulo + (sub ? '   ' + sub : ''))
        .setTextStyle(0, titulo.length, SpreadsheetApp.newTextStyle().setBold(true).setFontSize(13).setForegroundColor(TEXTO).setFontFamily('Montserrat').build())
        .build());
    r.setRowHeight(lin, 34);
    lin++;
  };
  const cab = (cols) => {
    r.getRange(lin, PC.NOME, 1, cols.length).setValues([cols]).setFontWeight('bold').setFontSize(9)
      .setFontColor(SUAVE).setBackground(BRANCO).setHorizontalAlignment('center')
      .setBorder(null, null, true, null, null, null, LINHA, SpreadsheetApp.BorderStyle.SOLID);
    r.getRange(lin, PC.NOME).setHorizontalAlignment('left');
    r.setRowHeight(lin, 28);
    lin++;
  };
  const linhaTabela = (valores, x, listas) => {
    const f = valores[1], t = valores[2];
    r.getRange(lin, PC.NOME, 1, valores.length).setValues([valores]).setBackground(BRANCO)
      .setBorder(null, null, true, null, null, null, LINHA, SpreadsheetApp.BorderStyle.SOLID);
    r.getRange(lin, PC.NOME).setFontWeight('bold').setWrap(true);
    r.getRange(lin, PC.FEITAS, 1, PC.EXTRA - PC.FEITAS + 1).setHorizontalAlignment('center');
    r.getRange(lin, PC.FEITAS, 1, 2).setNumberFormat('0'); // sem herdar formato de data de atualizações anteriores
    r.getRange(lin, PC.PCT).setNumberFormat('0%').setFontWeight('bold').setFontColor(corDe(x));
    F(r.getRange(lin, PC.BARRA), barra(f, t, corDe(x)));
    r.getRange(lin, listas, 1, PC.LISTA2 - listas + 1).setWrap(true).setFontSize(9).setFontColor(SUAVE).setVerticalAlignment('middle');
    lin++;
  };
  const total = (rot, f, t, extra) => {
    const x = pct(f, t);
    r.getRange(lin, PC.NOME, 1, 4).setValues([[rot, f, t, x]]).setFontWeight('bold').setBackground('#e8edf6');
    r.getRange(lin, PC.FEITAS, 1, 3).setHorizontalAlignment('center');
    r.getRange(lin, PC.FEITAS, 1, 2).setNumberFormat('0');
    r.getRange(lin, PC.PCT).setNumberFormat('0%').setFontColor(corDe(x));
    F(r.getRange(lin, PC.BARRA), barra(f, t, corDe(x)));
    r.getRange(lin, PC.BARRA, 1, PC.LISTA2 - PC.BARRA + 1).setBackground('#e8edf6');
    if (extra != null) r.getRange(lin, PC.EXTRA).setValue(extra).setHorizontalAlignment('center').setFontWeight('bold');
    r.setRowHeight(lin, 28);
    lin++;
  };

  // ---- gráficos: os números ficam nas próprias células embaixo de cada gráfico (o gráfico cobre e esconde)
  const lst = ss.getSheetByName(ABA_LISTAS);
  const dv = [['Colaborador', 'Feitas', 'Pendentes']].concat((V.pessoas || []).map((p) => [p.nome, p.feitas, p.total - p.feitas]));
  const dl = [['Responsável', 'Feitas', 'A fazer']].concat((L.pessoas || []).map((p) => [p.nome, p.feitas, p.total - p.feitas]));
  const grafico = (range, titulo, linha, coluna, largura) => r.insertChart(r.newChart()
    .setChartType(Charts.ChartType.BAR).addRange(range).setNumHeaders(1)
    .setOption('isStacked', true).setOption('title', titulo)
    .setOption('titleTextStyle', { color: TEXTO, fontSize: 13, bold: true })
    .setOption('colors', [OK, '#e57373']).setOption('legend', { position: 'top', textStyle: { color: SUAVE } })
    .setOption('backgroundColor', BRANCO).setOption('chartArea', { left: 110, top: 50, width: '70%', height: '75%' })
    .setOption('hAxis', { textStyle: { color: SUAVE }, gridlines: { color: LINHA } })
    .setOption('vAxis', { textStyle: { color: TEXTO } })
    .setOption('width', largura).setOption('height', 260)
    .setPosition(linha, coluna, 0, 0).build());
  secao('Visão geral');
  const rv = r.getRange(lin, PC.NOME, dv.length, 3).setValues(dv).setFontColor(FUNDO).setFontSize(6);
  const rl = r.getRange(lin, PC.BARRA + 1, dl.length, 3).setValues(dl).setFontColor(FUNDO).setFontSize(6);
  SpreadsheetApp.flush();
  grafico(rv, 'Vistorias da semana por colaborador', lin, PC.NOME, 560);
  grafico(rl, 'Leituras do mês por responsável', lin, PC.BARRA + 1, 560);
  for (let i = 0; i < 13; i++) r.setRowHeight(lin + i, 21);
  lin += 14;

  // ---- vistorias por colaborador
  secao('Vistorias da semana', V.semana);
  cab(['Colaborador', 'Feitas', 'Total', '%', 'Progresso', 'Idas extras', 'Condomínios pendentes', '']);
  r.getRange(lin - 1, PC.LISTA, 1, 2).merge().setHorizontalAlignment('left');
  (V.pessoas || []).forEach((p) => {
    linhaTabela([p.nome, p.feitas, p.total, pct(p.feitas, p.total), '', p.extras, p.pendentes.join('  ·  ') || '✓ todos vistoriados'], pct(p.feitas, p.total), PC.LISTA);
    r.getRange(lin - 1, PC.LISTA, 1, 2).merge();
    r.setRowHeight(lin - 1, Math.max(30, 15 * Math.ceil((p.pendentes.join('  ·  ').length || 1) / 95) + 10));
  });
  total('Total', V.feitas, V.total, (V.pessoas || []).reduce((t, p) => t + p.extras, 0));
  lin++;

  // ---- leituras por responsável
  secao('Leituras do mês', L.mes);
  cab(['Responsável', 'Feitas', 'Total', '%', 'Progresso', 'Atrasadas', 'Nesta semana', 'Depois']);
  (L.pessoas || []).forEach((p) => {
    const at = p.atrasadas.length;
    linhaTabela([p.nome, p.feitas, p.total, pct(p.feitas, p.total), '', at || '—', p.semana.join('  ·  ') || '—', p.depois.join('  ·  ') || '—'], pct(p.feitas, p.total), PC.LISTA);
    if (at) r.getRange(lin - 1, PC.EXTRA).setFontColor(RUIM).setFontWeight('bold').setNote('Atrasadas: ' + p.atrasadas.join(', '));
    const maior = Math.max(p.semana.join('  ·  ').length, p.depois.join('  ·  ').length);
    r.setRowHeight(lin - 1, Math.max(30, 15 * Math.ceil((maior || 1) / 45) + 10));
  });
  total('Total', L.feitas, L.total, atrasadas || '—');
  lin++;

  // ---- idas por condomínio (filtro)
  secao('Idas por condomínio', 'escolha nas células amarelas  ·  para imprimir: menu Alpha → Gerar relatório em PDF');
  const f0 = lin;
  const hoje = new Date();
  // rótulos
  r.getRange(lin, PC.NOME, 3, 1).setValues([['CONDOMÍNIO'], ['DE'], ['ATÉ']]).setFontSize(8).setFontWeight('bold')
    .setFontColor(SUAVE).setHorizontalAlignment('right').setBackground(BRANCO);
  // campos amarelos (C:F)
  for (let i = 0; i < 3; i++) r.getRange(lin + i, PC.FEITAS, 1, 4).merge();
  r.getRange(lin, PC.FEITAS).setValue(filtro.condo || lst.getRange('A2').getValue() || '');
  r.getRange(lin + 1, PC.FEITAS).setValue(filtro.de || new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1)).setNumberFormat('dd/mm/yyyy');
  r.getRange(lin + 2, PC.FEITAS).setValue(filtro.ate || new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate())).setNumberFormat('dd/mm/yyyy');
  r.getRange(lin, PC.FEITAS, 3, 4).setBackground('#fff4cc').setFontWeight('bold').setFontSize(11).setHorizontalAlignment('left')
    .setBorder(true, true, true, true, null, true, '#e8c766', SpreadsheetApp.BorderStyle.SOLID);
  r.getRange(lin, PC.FEITAS).setFontSize(13).setFontColor(AZUL);
  r.getRange(lin, PC.FEITAS).setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInRange(lst.getRange('A2:A'), true).setAllowInvalid(false).build());
  r.getRange(lin + 1, PC.FEITAS, 2, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireDate().setAllowInvalid(false).build());
  r.getRange(lin, PC.NOME, 3, 5).setBorder(true, true, true, true, null, null, LINHA, SpreadsheetApp.BorderStyle.SOLID);
  const C = '$C$' + f0, D = '$C$' + (f0 + 1), A = '$C$' + (f0 + 2);
  const cond = ABA + '!F2:F, ' + C + ', ' + ABA + '!B2:B, ">="&' + D + ', ' + ABA + '!B2:B, "<="&' + A;
  // três cartões (G, H, I) com faixa colorida
  const mini = (c, titulo, f, sub, cor) => {
    r.getRange(lin, c).setValue(titulo).setFontSize(8).setFontWeight('bold').setFontColor(SUAVE);
    F(r.getRange(lin + 1, c), f);
    r.getRange(lin + 1, c).setFontSize(24).setFontWeight('bold').setFontColor(cor).setFontFamily('Montserrat');
    if (sub.charAt(0) === '=') F(r.getRange(lin + 2, c), sub); else r.getRange(lin + 2, c).setValue(sub);
    r.getRange(lin + 2, c).setFontSize(8).setFontColor(SUAVE);
    r.getRange(lin, c, 3, 1).setBackground(BRANCO).setHorizontalAlignment('center')
      .setBorder(true, true, true, true, null, null, LINHA, SpreadsheetApp.BorderStyle.SOLID);
    r.getRange(lin, c, 3, 1).setBorder(null, true, null, null, null, null, cor, SpreadsheetApp.BorderStyle.SOLID_THICK);
  };
  mini(PC.EXTRA, 'VISTORIAS', '=IF(' + C + '="", "–", COUNTIFS(' + cond + ', ' + ABA + '!I2:I, "Vistoria da semana"))', 'vistoria da semana', OK);
  mini(PC.LISTA, 'IDAS EXTRAS', '=IF(' + C + '="", "–", COUNTIFS(' + cond + ', ' + ABA + '!I2:I, "Ida extra"))', 'manutenção, entregas, assembleias…', '#ef6c00');
  mini(PC.LISTA2, 'TOTAL DE IDAS', '=IF(' + C + '="", "–", COUNTIFS(' + cond + '))',
    '=IF(' + C + '="", "", "tempo no condomínio: " & IFERROR(TEXT(SUMPRODUCT((' + ABA + '!F2:F=' + C + ')*(' + ABA + '!B2:B>=' + D + ')*(' + ABA + '!B2:B<=' + A +
    ')*IFERROR(TIMEVALUE(' + ABA + '!N2:N&":00"), 0)), "[h]:mm") & " h", "-"))', AZUL);
  r.setRowHeight(lin, 26); r.setRowHeight(lin + 1, 40); r.setRowHeight(lin + 2, 26);
  lin += 4;
  // tabela
  r.getRange(lin, PC.NOME, 1, 8).setValues([['Data', 'Dia', 'Entrada', 'Saída', 'Tipo', 'Quem foi', 'Motivo / causa', 'Observação']])
    .setFontWeight('bold').setFontSize(9).setFontColor(BRANCO).setBackground(AZUL).setHorizontalAlignment('center');
  r.getRange(lin, PC.NOME).setHorizontalAlignment('left');
  r.getRange(lin, PC.LISTA, 1, 2).setHorizontalAlignment('left');
  r.setRowHeight(lin, 30);
  lin++;
  const col = (c) => ABA + '!' + c + '2:' + c;
  F(r.getRange(lin, PC.NOME), '=IF(' + C + '="", "Escolha o condomínio", IFERROR(SORT(FILTER({' +
    ['B', 'C', 'K', 'L', 'I', 'H', 'J', 'Q'].map(col).join(', ') + '}, ' +
    col('F') + '=' + C + ', ' + col('B') + '>=' + D + ', ' + col('B') + '<=' + A + '), 1, FALSE), "Nenhuma ida no período."))');
  const n = 200;
  r.getRange(lin, PC.NOME, n, 8).setBackground(BRANCO).setFontSize(10).setVerticalAlignment('middle');
  r.getRange(lin, PC.NOME, n, 1).setNumberFormat('dd/mm/yyyy').setHorizontalAlignment('left').setFontWeight('bold');
  r.getRange(lin, PC.FEITAS, n, 5).setHorizontalAlignment('center');
  r.getRange(lin, PC.FEITAS, n, 1).setFontColor(SUAVE);
  r.getRange(lin, PC.LISTA, n, 2).setWrap(true).setFontColor('#4a5568');
  r.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Vistoria da semana').setBackground('#e6f4ea').setFontColor(OK).setBold(true).setRanges([r.getRange(lin, PC.BARRA, n, 1)]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Ida extra').setBackground('#fff1e6').setFontColor('#c25e00').setBold(true).setRanges([r.getRange(lin, PC.BARRA, n, 1)]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=AND($B' + lin + '<>"", ISEVEN(ROW()))').setBackground('#f7f9fc').setRanges([r.getRange(lin, PC.NOME, n, 8)]).build(),
  ]);
  r.getRange(lin, PC.NOME, n, 8).setBorder(null, null, null, null, null, true, LINHA, SpreadsheetApp.BorderStyle.SOLID);
  r.setFrozenRows(0);
  return r.getRange(f0, PC.FEITAS, 3, 4); // células do filtro, com a mesclagem inteira (C:F), liberadas para edição
}

// Planilha em português? (testa uma vez por atualização, numa célula da aba oculta)
function usarPortugues(ss) {
  const loc = String(ss.getSpreadsheetLocale() || '');
  if (/^en/i.test(loc)) return false;
  if (/^pt/i.test(loc)) return true;
  const c = ss.getSheetByName(ABA_LISTAS).getRange('Z1');
  c.setFormula('=IF(1,1,0)');
  SpreadsheetApp.flush();
  const pt = String(c.getDisplayValue()).indexOf('#') === 0;
  c.clearContent();
  return pt;
}

// ---------------------------------------------------------------- aba Assembleia
function criarAssembleia(ss) {
  const a = ss.insertSheet(ABA_ASSEMBLEIA, 0);
  a.setHiddenGridlines(true);
  [110, 50, 110, 145, 230, 70, 70, 75, 220].forEach((w, i) => a.setColumnWidth(i + 1, w));

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
    .requireValueInRange(ss.getSheetByName(ABA_LISTAS).getRange('A2:A'), true).setAllowInvalid(false).build());
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
  const primeiro = String(ss.getSheetByName(ABA_LISTAS).getRange('A2').getDisplayValue() || '');
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
    // escolha de semana/colaborador na aba Vistorias da semana: refaz a aba na hora
    if (sh.getName() === ABA_SEMANA && e.range.getRow() === SEM_LINHA_ESCOLHA) { escreverAbaSemana(sh.getParent()); return; }
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

// ---------------------------------------------------------------- proteção
// Só o sistema (e o dono da planilha) altera os dados. Ficam liberados para quem edita:
//   Idas → coluna Observação · Leituras → coluna Responsável · Resumo e Assembleia → as células amarelas do filtro.
const TAG_PROTECAO = 'Alpha: atualizado pelo sistema';
function protegerAbas(ss, filtroPainel) {
  const eu = Session.getEffectiveUser();
  const liberar = {};
  liberar[ABA] = (s) => [s.getRange(2, COL_OBS, Math.max(s.getMaxRows() - 1, 1), 1)];
  liberar[ABA_LEITURAS] = (s) => [s.getRange(2, 2, Math.max(s.getMaxRows() - 1, 1), 1)];
  liberar[ABA_RESUMO] = () => (filtroPainel ? [filtroPainel] : []);
  liberar[ABA_ASSEMBLEIA] = (s) => [s.getRange('B4:E6')];
  liberar[ABA_LISTAS] = () => [];
  liberar[ABA_PEND] = () => [];
  liberar[ABA_SEMANA] = (s) => [s.getRange(SEM_LINHA_ESCOLHA, 3, 1, 2), s.getRange(SEM_LINHA_ESCOLHA, 7, 1, 2)]; // células mescladas inteiras
  Object.keys(liberar).forEach((nome) => {
    const sh = ss.getSheetByName(nome);
    if (!sh) return;
    sh.getProtections(SpreadsheetApp.ProtectionType.SHEET)
      .filter((p) => p.getDescription() === TAG_PROTECAO).forEach((p) => p.remove());
    const p = sh.protect().setDescription(TAG_PROTECAO);
    p.setUnprotectedRanges(liberar[nome](sh));
    p.addEditor(eu);
    p.removeEditors(p.getEditors().filter((u) => u.getEmail() !== eu.getEmail()));
    if (p.canDomainEdit()) p.setDomainEdit(false);
  });
}

// ---------------------------------------------------------------- relatório em PDF
// Usa o condomínio e o período escolhidos na aba Resumo (ou, se não houver, na Assembleia).
function gerarRelatorioPDF() {
  const ss = planilha();
  const esc = escolhaAtual(ss);
  if (!esc.condo) { SpreadsheetApp.getUi().alert('Escolha o condomínio e o período na aba Resumo (células amarelas) e tente de novo.'); return; }
  const de = new Date(esc.de), ate = new Date(esc.ate);
  ate.setHours(23, 59, 59);
  const sh = ss.getSheetByName(ABA);
  const dados = sh.getRange(2, 1, Math.max(sh.getLastRow() - 1, 1), COL_OBS).getValues()
    .filter((l) => l[0] && l[5] === esc.condo && l[1] instanceof Date && l[1] >= de && l[1] <= ate)
    .sort((a, b) => (a[1] - b[1]) || String(a[10]).localeCompare(String(b[10])));
  const html = montarRelatorioHTML(esc.condo, de, ate, dados, equipeDoCondominio(ss, esc.condo, dados));
  const nome = 'Relatório de visitas - ' + esc.condo + ' - ' + fmtData(de).replace(/\//g, '-') + ' a ' + fmtData(ate).replace(/\//g, '-') + '.pdf';
  const pdf = Utilities.newBlob(html, 'text/html', 'relatorio.html').getAs('application/pdf').setName(nome);
  const pasta = pastaRelatorios();
  const arq = pasta.createFile(pdf);
  const ui = HtmlService.createHtmlOutput(
    '<div style="font-family:Arial,sans-serif;padding:8px 4px">' +
    '<p style="margin:0 0 6px;color:#1f2a44;font-size:14px"><b>Relatório gerado</b></p>' +
    '<p style="margin:0 0 14px;color:#7a869a;font-size:12px">' + escapar(nome) + '<br>Salvo na pasta <b>' + escapar(pasta.getName()) + '</b> do seu Google Drive.</p>' +
    (avisoLogo ? '<p style="margin:0 0 12px;color:#c62828;font-size:12px">⚠️ ' + escapar(avisoLogo) + '</p>' : '') +
    '<a href="' + arq.getUrl() + '" target="_blank" style="display:inline-block;background:#1f3864;color:#fff;padding:9px 16px;border-radius:6px;text-decoration:none;font-size:13px">Abrir PDF</a>' +
    '</div>').setWidth(400).setHeight(avisoLogo ? 230 : 170);
  SpreadsheetApp.getUi().showModalDialog(ui, 'Alpha');
}

function escolhaAtual(ss) {
  const r = ss.getSheetByName(ABA_RESUMO);
  if (r && r.getLastRow()) {
    const colB = r.getRange(1, 2, r.getLastRow(), 1).getValues();
    for (let i = 0; i < colB.length; i++) {
      if (colB[i][0] === 'CONDOMÍNIO' || colB[i][0] === 'Condomínio') {
        const v = r.getRange(i + 1, 3, 3, 1).getValues();
        if (v[0][0]) return { condo: v[0][0], de: v[1][0], ate: v[2][0] };
      }
    }
  }
  const a = ss.getSheetByName(ABA_ASSEMBLEIA);
  if (a) { const v = a.getRange('B4:B6').getValues(); return { condo: v[0][0], de: v[1][0], ate: v[2][0] }; }
  return {};
}

function pastaRelatorios() {
  const nome = 'Alpha - Relatórios de visitas';
  const it = DriveApp.getFoldersByName(nome);
  return it.hasNext() ? it.next() : DriveApp.createFolder(nome);
}

function fmtData(d) { return Utilities.formatDate(d, 'America/Sao_Paulo', 'dd/MM/yyyy'); }
function escapar(t) { return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

let avisoLogo = '';
function logoBase64() {
  avisoLogo = '';
  if (!LOGO) return '';
  try {
    // aceita o link do Drive inteiro (…/file/d/ID/view…), só o ID, ou um link direto de imagem
    const id = (LOGO.match(/\/d\/([\w-]{20,})/) || LOGO.match(/[?&]id=([\w-]{20,})/) || [])[1] || (/^[\w-]{20,}$/.test(LOGO) ? LOGO : '');
    let blob = id ? DriveApp.getFileById(id).getBlob() : UrlFetchApp.fetch(LOGO).getBlob();
    const tipo = String(blob.getContentType() || '');
    if (!/^image\/(png|jpe?g|gif)$/i.test(tipo)) {
      // SVG, WEBP, PDF etc. não aparecem no PDF: tenta converter para PNG
      try { blob = blob.getAs('image/png'); } catch (e) {
        avisoLogo = 'A logo está em formato ' + tipo + ', que não aparece no PDF. Use um arquivo PNG ou JPG.';
        return '';
      }
    }
    return 'data:' + blob.getContentType() + ';base64,' + Utilities.base64Encode(blob.getBytes());
  } catch (e) {
    avisoLogo = 'Não consegui ler a logo: ' + e.message + '. Confira o link na linha LOGO do script.';
    return '';
  }
}

function equipeDoCondominio(ss, condo, dados) {
  const sh = ss.getSheetByName(ABA);
  const todas = sh.getRange(2, 1, Math.max(sh.getLastRow() - 1, 1), 8).getValues().filter((l) => l[5] === condo);
  const resp = (dados.find((l) => l[6]) || todas.find((l) => l[6]) || [])[6] || '';
  const chave = Object.keys(LIDERANCA).find((k) => k.toLowerCase() === String(resp).toLowerCase());
  const lider = chave ? LIDERANCA[chave] : '';
  const foram = Array.from(new Set(dados.map((l) => l[7]).filter(String))).filter((p) => p !== resp);
  return { resp: resp, lider: lider, foram: foram };
}

function montarRelatorioHTML(condo, de, ate, dados, equipe) {
  equipe = equipe || { resp: '', lider: '', foram: [] };
  const azul = '#1f3864', suave = '#6b778c', linha = '#dfe5ee';
  const vist = dados.filter((l) => l[8] === 'Vistoria da semana').length;
  const extras = dados.length - vist;
  let minutos = 0;
  dados.forEach((l) => { const m = String(l[13] || '').match(/^(\d+):(\d{2})$/); if (m) minutos += Number(m[1]) * 60 + Number(m[2]); });
  const tempo = Math.floor(minutos / 60) + 'h' + String(minutos % 60).padStart(2, '0');
  // por mês
  const meses = {};
  dados.forEach((l) => { const k = Utilities.formatDate(l[1], 'America/Sao_Paulo', 'MM/yyyy'); meses[k] = meses[k] || [0, 0]; meses[k][l[8] === 'Vistoria da semana' ? 0 : 1]++; });
  const logo = logoBase64();
  const marca = logo
    ? '<img src="' + logo + '" style="height:54px">'
    : '<div style="font-size:24px;font-weight:bold;color:' + azul + ';letter-spacing:1px">ALPHA</div><div style="font-size:10px;color:' + suave + ';letter-spacing:3px">ADMINISTRADORA</div>';
  const caixa = (titulo, valor, cor) =>
    '<td style="width:25%;padding:0 6px"><div style="border:1px solid ' + linha + ';border-left:4px solid ' + cor + ';padding:10px 12px;border-radius:4px">' +
    '<div style="font-size:9px;color:' + suave + ';font-weight:bold;letter-spacing:1px">' + titulo + '</div>' +
    '<div style="font-size:22px;font-weight:bold;color:' + cor + ';margin-top:4px">' + valor + '</div></div></td>';
  const linhas = dados.map((l, i) => {
    const vistoria = l[8] === 'Vistoria da semana';
    const est = l[12] === 'Sim' ? '*' : '';
    return '<tr style="background:' + (i % 2 ? '#f7f9fc' : '#ffffff') + '">' +
      '<td style="padding:6px 8px;font-weight:bold">' + fmtData(l[1]) + '</td>' +
      '<td style="padding:6px 8px;color:' + suave + '">' + escapar(l[2]) + '</td>' +
      '<td style="padding:6px 8px;text-align:center">' + escapar(l[10] || '—') + '</td>' +
      '<td style="padding:6px 8px;text-align:center">' + escapar((l[11] || '—') + (l[11] ? est : '')) + '</td>' +
      '<td style="padding:6px 8px;text-align:center">' + escapar(l[13] || '—') + '</td>' +
      '<td style="padding:6px 8px"><span style="font-size:9px;font-weight:bold;padding:2px 7px;border-radius:9px;color:' + (vistoria ? '#2e7d32' : '#c25e00') +
        ';background:' + (vistoria ? '#e6f4ea' : '#fff1e6') + '">' + (vistoria ? 'VISTORIA' : 'IDA EXTRA') + '</span></td>' +
      '<td style="padding:6px 8px">' + escapar(l[7]) + '</td>' +
      '<td style="padding:6px 8px;color:#3d4757">' + escapar(l[9] || '') + (l[16] ? '<div style="color:' + suave + ';font-size:9px;margin-top:2px">Obs.: ' + escapar(l[16]) + '</div>' : '') + '</td></tr>';
  }).join('');
  const th = (t, al) => '<th style="padding:7px 8px;text-align:' + (al || 'left') + ';font-size:9px;letter-spacing:.5px;color:#fff;background:' + azul + '">' + t + '</th>';
  const tabelaMeses = Object.keys(meses).length > 1
    ? '<h3 style="font-size:12px;color:' + azul + ';margin:22px 0 8px">Resumo por mês</h3><table style="border-collapse:collapse;width:60%;font-size:10px">' +
      '<tr>' + th('MÊS') + th('VISTORIAS', 'center') + th('IDAS EXTRAS', 'center') + th('TOTAL', 'center') + '</tr>' +
      Object.keys(meses).sort((a, b) => a.slice(3) + a.slice(0, 2) < b.slice(3) + b.slice(0, 2) ? -1 : 1).map((k, i) => '<tr style="background:' + (i % 2 ? '#f7f9fc' : '#fff') + '"><td style="padding:5px 8px">' + k + '</td><td style="padding:5px 8px;text-align:center">' + meses[k][0] +
        '</td><td style="padding:5px 8px;text-align:center">' + meses[k][1] + '</td><td style="padding:5px 8px;text-align:center;font-weight:bold">' + (meses[k][0] + meses[k][1]) + '</td></tr>').join('') + '</table>'
    : '';
  return '<html><head><meta charset="utf-8"></head><body style="font-family:Arial,Helvetica,sans-serif;color:#1f2a44;font-size:10px;margin:0">' +
    '<table style="width:100%;border-collapse:collapse"><tr>' +
    '<td style="vertical-align:middle">' + marca + '</td>' +
    '<td style="text-align:right;vertical-align:middle"><div style="font-size:16px;font-weight:bold;color:' + azul + '">RELATÓRIO DE VISITAS</div>' +
    '<div style="font-size:9px;color:' + suave + ';margin-top:3px">Emitido em ' + fmtData(new Date()) + '</div></td></tr></table>' +
    '<div style="height:3px;background:' + azul + ';margin:12px 0 18px"></div>' +
    '<div style="font-size:9px;color:' + suave + ';letter-spacing:1px;font-weight:bold">CONDOMÍNIO</div>' +
    '<div style="font-size:22px;font-weight:bold;color:' + azul + ';margin:2px 0 4px">' + escapar(condo) + '</div>' +
    '<div style="font-size:11px;color:' + suave + '">Período: <b style="color:#1f2a44">' + fmtData(de) + ' a ' + fmtData(ate) + '</b></div>' +
    // equipe: responsável, liderança direta e quem mais foi
    '<table style="border-collapse:collapse;margin-top:12px;font-size:10px"><tr>' +
      (equipe.resp ? '<td style="padding:6px 14px 6px 10px;border-left:3px solid ' + azul + ';background:#f3f6fb"><div style="font-size:8px;color:' + suave + ';font-weight:bold;letter-spacing:1px">RESPONSÁVEL</div><div style="font-size:12px;font-weight:bold;margin-top:2px">' + escapar(equipe.resp) + '</div></td><td style="width:10px"></td>' : '') +
      (equipe.lider ? '<td style="padding:6px 14px 6px 10px;border-left:3px solid ' + azul + ';background:#f3f6fb"><div style="font-size:8px;color:' + suave + ';font-weight:bold;letter-spacing:1px">LIDERANÇA DIRETA</div><div style="font-size:12px;font-weight:bold;margin-top:2px">' + escapar(equipe.lider) + '</div></td><td style="width:10px"></td>' : '') +
      (equipe.foram.length ? '<td style="padding:6px 14px 6px 10px;border-left:3px solid ' + linha + ';background:#f3f6fb"><div style="font-size:8px;color:' + suave + ';font-weight:bold;letter-spacing:1px">TAMBÉM ATENDERAM</div><div style="font-size:12px;margin-top:2px">' + escapar(equipe.foram.join(', ')) + '</div></td>' : '') +
    '</tr></table>' +
    '<table style="width:100%;border-collapse:collapse;margin:18px -6px 6px"><tr>' +
      caixa('VISTORIAS', vist, '#2e7d32') + caixa('IDAS EXTRAS', extras, '#ef6c00') + caixa('TOTAL DE IDAS', dados.length, azul) + caixa('TEMPO NO CONDOMÍNIO', tempo, azul) +
    '</tr></table>' +
    tabelaMeses +
    '<h3 style="font-size:12px;color:' + azul + ';margin:22px 0 8px">Registro das idas</h3>' +
    (dados.length
      ? '<table style="width:100%;border-collapse:collapse;font-size:10px">' +
        '<tr>' + th('DATA') + th('DIA') + th('ENTRADA', 'center') + th('SAÍDA', 'center') + th('DURAÇÃO', 'center') + th('TIPO') + th('QUEM FOI') + th('MOTIVO / CAUSA') + '</tr>' +
        linhas + '</table>'
      : '<p style="color:' + suave + '">Nenhuma ida registrada no período.</p>') +
    '<div style="margin-top:16px;font-size:8.5px;color:' + suave + ';line-height:1.5">' +
      '<b>Vistoria</b>: visita da semana ao condomínio. <b>Ida extra</b>: demais idas (manutenção, entregas, assembleias, acompanhamento de serviços).<br>' +
      'Horários registrados a partir dos avisos da equipe nos grupos do condomínio. * saída estimada.' +
    '</div>' +
    '<div style="border-top:1px solid ' + linha + ';margin-top:26px;padding-top:8px;font-size:8.5px;color:' + suave + '">' +
      'Alpha Administradora · alphacondominios.com</div>' +
    '</body></html>';
}

// ---------------------------------------------------------------- relatório da semana (vistorias feitas e a fazer)
// Usa a semana e o colaborador escolhidos na aba "Vistorias da semana" (sem janela de escolha: a janela
// dá erro de permissão quando há mais de uma conta Google aberta no navegador).
function abrirRelatorioSemana() {
  const ss = planilha();
  const r = ss.getSheetByName(ABA_SEMANA);
  let escSem = 'Esta semana', escPes = 'Todos';
  if (r && r.getLastRow() >= SEM_LINHA_ESCOLHA) {
    escSem = r.getRange(SEM_LINHA_ESCOLHA, 3).getValue() || escSem;
    escPes = r.getRange(SEM_LINHA_ESCOLHA, 7).getValue() || escPes;
  }
  const url = gerarRelatorioSemana(-Math.max(0, SEMANAS.indexOf(escSem)), escPes === 'Todos' ? '' : escPes);
  const ui = HtmlService.createHtmlOutput(
    '<div style="font-family:Arial,sans-serif;padding:8px 4px">' +
    '<p style="margin:0 0 6px;color:#1f2a44;font-size:14px"><b>Relatório gerado</b></p>' +
    '<p style="margin:0 0 14px;color:#7a869a;font-size:12px">' + escapar(escSem) + ' · ' + escapar(escPes) +
    '<br>Para mudar, escolha a semana e o colaborador na aba <b>Vistorias da semana</b>.' +
    (avisoLogo ? '<br><span style="color:#c62828">⚠️ ' + escapar(avisoLogo) + '</span>' : '') + '</p>' +
    '<a href="' + url + '" target="_blank" style="display:inline-block;background:#1f3864;color:#fff;padding:9px 16px;border-radius:6px;text-decoration:none;font-size:13px">Abrir PDF</a>' +
    '</div>').setWidth(400).setHeight(avisoLogo ? 230 : 190);
  SpreadsheetApp.getUi().showModalDialog(ui, 'Alpha');
}

function buscarSemana(offset) {
  const url = URL_IDAS.replace('/api/idas/', '/api/semana/') + '?offset=' + offset;
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('O servidor respondeu ' + res.getResponseCode() + ' (confira se o sistema está na versão mais nova).');
  return JSON.parse(res.getContentText());
}

function gerarRelatorioSemana(offset, pessoa) {
  const sem = buscarSemana(offset || 0);
  let pessoas = sem.pessoas || [];
  if (pessoa) pessoas = pessoas.filter((p) => p.nome === pessoa);
  const html = montarRelatorioSemanaHTML(sem, pessoas, pessoa);
  const nome = 'Vistorias da semana ' + String(sem.semana).replace(/\//g, '-') + (pessoa ? ' - ' + pessoa : '') + '.pdf';
  const arq = pastaRelatorios().createFile(Utilities.newBlob(html, 'text/html', 'semana.html').getAs('application/pdf').setName(nome));
  return arq.getUrl();
}

function montarRelatorioSemanaHTML(sem, pessoas, filtroPessoa) {
  const azul = '#1f3864', suave = '#6b778c', linha = '#dfe5ee', ok = '#2e7d32', ruim = '#c62828';
  const total = pessoas.reduce((t, p) => t + p.total, 0);
  const feitas = pessoas.reduce((t, p) => t + p.feitas, 0);
  const pct = total ? Math.round((feitas / total) * 100) : 0;
  const logo = logoBase64();
  const marca = logo
    ? '<img src="' + logo + '" style="height:54px">'
    : '<div style="font-size:24px;font-weight:bold;color:' + azul + ';letter-spacing:1px">ALPHA</div><div style="font-size:10px;color:' + suave + ';letter-spacing:3px">ADMINISTRADORA</div>';
  const caixa = (titulo, valor, cor) =>
    '<td style="width:25%;padding:0 6px"><div style="border:1px solid ' + linha + ';border-left:4px solid ' + cor + ';padding:10px 12px;border-radius:4px">' +
    '<div style="font-size:9px;color:' + suave + ';font-weight:bold;letter-spacing:1px">' + titulo + '</div>' +
    '<div style="font-size:22px;font-weight:bold;color:' + cor + ';margin-top:4px">' + valor + '</div></div></td>';
  const th = (t, al) => '<th style="padding:6px 8px;text-align:' + (al || 'left') + ';font-size:9px;letter-spacing:.5px;color:#fff;background:' + azul + '">' + t + '</th>';
  const barra = (p) => '<table style="border-collapse:collapse;width:160px;height:8px"><tr>' +
    (p ? '<td style="width:' + p + '%;background:' + (p >= 80 ? ok : p >= 50 ? '#f9a825' : ruim) + ';height:8px"></td>' : '') +
    (p < 100 ? '<td style="background:' + linha + ';height:8px"></td>' : '') + '</tr></table>';
  const blocos = pessoas.map((p) => {
    const pc = p.total ? Math.round((p.feitas / p.total) * 100) : 0;
    const chave = Object.keys(LIDERANCA).find((k) => k.toLowerCase() === String(p.nome).toLowerCase());
    const feitasTab = (p.detalhe || []).length
      ? '<table style="width:100%;border-collapse:collapse;font-size:10px;margin-top:6px"><tr>' + th('DATA') + th('DIA') + th('CONDOMÍNIO') + th('ENTRADA', 'center') + th('SAÍDA', 'center') + th('QUEM FOI') + '</tr>' +
        p.detalhe.map((d, i) => '<tr style="background:' + (i % 2 ? '#f7f9fc' : '#fff') + '"><td style="padding:5px 8px;font-weight:bold">' + d.data + '</td><td style="padding:5px 8px;color:' + suave + '">' + d.dia +
          '</td><td style="padding:5px 8px;font-weight:bold">' + escapar(d.condo) + '</td><td style="padding:5px 8px;text-align:center">' + (d.entrada || '—') + '</td><td style="padding:5px 8px;text-align:center">' + (d.saida || '—') +
          '</td><td style="padding:5px 8px">' + escapar(d.quem) + '</td></tr>').join('') + '</table>'
      : '<p style="color:' + suave + ';margin:6px 0">Nenhuma vistoria registrada na semana.</p>';
    const pend = (p.pendentes || []).length
      ? '<div style="margin-top:6px;line-height:2">' + p.pendentes.map((n) => '<span style="display:inline-block;font-size:9.5px;padding:2px 8px;margin:0 4px 4px 0;border-radius:9px;background:#fdecea;color:' + ruim + '">' + escapar(n) + '</span>').join('') + '</div>'
      : '<p style="color:' + ok + ';margin:6px 0;font-weight:bold">✓ Todos os condomínios vistoriados.</p>';
    return '<div style="page-break-inside:avoid;margin-top:22px;border:1px solid ' + linha + ';border-radius:6px;padding:12px 14px">' +
      '<table style="width:100%;border-collapse:collapse"><tr><td><div style="font-size:15px;font-weight:bold;color:' + azul + '">' + escapar(p.nome) + '</div>' +
      (chave ? '<div style="font-size:9px;color:' + suave + ';margin-top:2px">Liderança direta: <b>' + escapar(LIDERANCA[chave]) + '</b></div>' : '') + '</td>' +
      '<td style="text-align:right"><div style="font-size:18px;font-weight:bold;color:' + (pc >= 80 ? ok : pc >= 50 ? '#f9a825' : ruim) + '">' + p.feitas + ' / ' + p.total + ' · ' + pc + '%</div>' +
      '<div style="margin-top:4px;float:right">' + barra(pc) + '</div></td></tr></table>' +
      '<div style="font-size:10px;font-weight:bold;color:' + ok + ';margin-top:10px;letter-spacing:.5px">✅ VISTORIAS FEITAS (' + p.feitas + ')</div>' + feitasTab +
      '<div style="font-size:10px;font-weight:bold;color:' + ruim + ';margin-top:12px;letter-spacing:.5px">❌ A FAZER (' + (p.total - p.feitas) + ')</div>' + pend +
      '</div>';
  }).join('');
  return '<html><head><meta charset="utf-8"></head><body style="font-family:Arial,Helvetica,sans-serif;color:#1f2a44;font-size:10px;margin:0">' +
    '<table style="width:100%;border-collapse:collapse"><tr><td style="vertical-align:middle">' + marca + '</td>' +
    '<td style="text-align:right;vertical-align:middle"><div style="font-size:16px;font-weight:bold;color:' + azul + '">RELATÓRIO DE VISTORIAS</div>' +
    '<div style="font-size:9px;color:' + suave + ';margin-top:3px">Emitido em ' + fmtData(new Date()) + '</div></td></tr></table>' +
    '<div style="height:3px;background:' + azul + ';margin:12px 0 18px"></div>' +
    '<div style="font-size:9px;color:' + suave + ';letter-spacing:1px;font-weight:bold">SEMANA</div>' +
    '<div style="font-size:22px;font-weight:bold;color:' + azul + ';margin:2px 0 4px">' + escapar(sem.semana) + '</div>' +
    '<div style="font-size:11px;color:' + suave + '">' + (filtroPessoa ? 'Colaborador: <b style="color:#1f2a44">' + escapar(filtroPessoa) + '</b>' : 'Todos os colaboradores') + '</div>' +
    '<table style="width:100%;border-collapse:collapse;margin:18px -6px 0"><tr>' +
      caixa('VISTORIADOS', feitas + ' / ' + total, pct >= 80 ? ok : pct >= 50 ? '#f9a825' : ruim) + caixa('CONCLUÍDO', pct + '%', azul) +
      caixa('A FAZER', total - feitas, (total - feitas) ? ruim : ok) + caixa('IDAS EXTRAS', pessoas.reduce((t, p) => t + p.extras, 0), '#ef6c00') +
    '</tr></table>' +
    blocos +
    '<div style="margin-top:16px;font-size:8.5px;color:' + suave + ';line-height:1.5">Conta como vistoria a primeira ida da semana ao condomínio, de qualquer pessoa da equipe. ' +
      'Horários registrados a partir dos avisos da equipe nos grupos do condomínio. * saída estimada. “(sem grupo)”: a IA não está no grupo desse condomínio.</div>' +
    '<div style="border-top:1px solid ' + linha + ';margin-top:22px;padding-top:8px;font-size:8.5px;color:' + suave + '">Alpha Administradora · alphacondominios.com</div>' +
    '</body></html>';
}

// ---------------------------------------------------------------- aba Vistorias da semana (relatório na tela)
// Escolha a semana e o colaborador nas células amarelas: a aba se refaz na hora (e a cada atualização automática).
const SEM_LINHA_ESCOLHA = 5;
const SEMANAS = ['Esta semana', 'Semana passada', 'Há 2 semanas', 'Há 3 semanas', 'Há 4 semanas'];

function escreverAbaSemana(ss) {
  let r = ss.getSheetByName(ABA_SEMANA);
  if (!r) r = ss.insertSheet(ABA_SEMANA, 1);
  // escolhas atuais
  let escSem = 'Esta semana', escPes = 'Todos';
  if (r.getLastRow() >= SEM_LINHA_ESCOLHA) {
    escSem = r.getRange(SEM_LINHA_ESCOLHA, 3).getValue() || escSem;
    escPes = r.getRange(SEM_LINHA_ESCOLHA, 7).getValue() || escPes;
  }
  const offset = -Math.max(0, SEMANAS.indexOf(escSem));
  const sem = buscarSemana(offset);
  const todos = sem.pessoas || [];
  const pessoas = escPes && escPes !== 'Todos' ? todos.filter((p) => p.nome === escPes) : todos;

  r.getRange(1, 1, r.getMaxRows(), r.getMaxColumns()).breakApart();
  r.clear();
  r.getRange(1, 1, r.getMaxRows(), r.getMaxColumns()).setNumberFormat('@').clearDataValidations();
  r.clearConditionalFormatRules();
  if (r.getMaxColumns() < 9) r.insertColumnsAfter(r.getMaxColumns(), 9 - r.getMaxColumns());
  if (r.getMaxColumns() > 9) r.deleteColumns(10, r.getMaxColumns() - 9);
  r.setHiddenGridlines(true);
  [28, 120, 60, 260, 90, 90, 170, 150, 28].forEach((w, i) => r.setColumnWidth(i + 1, w));
  r.getRange(1, 1, r.getMaxRows(), 9).setBackground(FUNDO).setFontFamily('Roboto').setFontColor(TEXTO).setFontSize(10).setVerticalAlignment('middle');

  // cabeçalho
  r.setRowHeight(1, 14);
  r.getRange(2, 2, 1, 7).merge().setValue('Vistorias da semana').setFontFamily('Montserrat').setFontSize(20).setFontWeight('bold')
    .setFontColor(BRANCO).setBackground(AZUL);
  r.getRange(3, 2, 1, 7).merge().setValue('Semana ' + sem.semana + '  ·  vistorias feitas e a fazer por colaborador  ·  para imprimir: menu Alpha → Relatório de vistorias da semana (PDF)')
    .setFontSize(10).setFontColor('#c9d3e6').setBackground(AZUL);
  r.setRowHeight(2, 44); r.setRowHeight(3, 24);

  // escolhas
  const L = SEM_LINHA_ESCOLHA;
  r.getRange(L, 2).setValue('SEMANA').setFontSize(8).setFontWeight('bold').setFontColor(SUAVE).setHorizontalAlignment('right');
  r.getRange(L, 3, 1, 2).merge();
  r.getRange(L, 3).setValue(escSem).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(SEMANAS, true).setAllowInvalid(false).build());
  r.getRange(L, 6).setValue('COLABORADOR').setFontSize(8).setFontWeight('bold').setFontColor(SUAVE).setHorizontalAlignment('right');
  r.getRange(L, 7, 1, 2).merge();
  r.getRange(L, 7).setValue(escPes).setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(['Todos'].concat(todos.map((p) => p.nome)), true).setAllowInvalid(false).build());
  [r.getRange(L, 3, 1, 2), r.getRange(L, 7, 1, 2)].forEach((g) => g.setBackground('#fff4cc').setFontWeight('bold').setFontSize(12).setFontColor(AZUL)
    .setBorder(true, true, true, true, null, null, '#e8c766', SpreadsheetApp.BorderStyle.SOLID));
  r.setRowHeight(L, 32);

  // cartões
  const total = pessoas.reduce((t, p) => t + p.total, 0), feitas = pessoas.reduce((t, p) => t + p.feitas, 0);
  const x = total ? feitas / total : 0;
  const corDe = (v) => (v >= 0.8 ? OK : v >= 0.5 ? ALERTA : RUIM);
  const cartao = (c1, n, titulo, valor, cor) => {
    r.getRange(7, c1, 1, n).merge().setValue(titulo).setFontSize(8).setFontWeight('bold').setFontColor(SUAVE);
    r.getRange(8, c1, 1, n).merge().setValue(valor).setFontSize(22).setFontWeight('bold').setFontColor(cor).setFontFamily('Montserrat');
    r.getRange(7, c1, 2, n).setBackground(BRANCO).setHorizontalAlignment('center')
      .setBorder(true, true, true, true, null, null, LINHA, SpreadsheetApp.BorderStyle.SOLID);
    r.getRange(7, c1, 2, 1).setBorder(null, true, null, null, null, null, cor, SpreadsheetApp.BorderStyle.SOLID_THICK);
  };
  cartao(2, 2, 'VISTORIADOS', feitas + ' / ' + total, corDe(x));
  cartao(4, 1, 'CONCLUÍDO', Math.round(x * 100) + '%', corDe(x));
  cartao(5, 2, 'A FAZER', String(total - feitas), (total - feitas) ? RUIM : OK);
  cartao(7, 2, 'IDAS EXTRAS', String(pessoas.reduce((t, p) => t + p.extras, 0)), '#ef6c00');
  r.setRowHeight(7, 22); r.setRowHeight(8, 38);

  let lin = 10;
  pessoas.forEach((p) => {
    const pc = p.total ? p.feitas / p.total : 0;
    const chave = Object.keys(LIDERANCA).find((k) => k.toLowerCase() === String(p.nome).toLowerCase());
    // título do colaborador
    r.getRange(lin, 2, 1, 4).merge().setRichTextValue(SpreadsheetApp.newRichTextValue()
      .setText(p.nome + (chave ? '   liderança: ' + LIDERANCA[chave] : ''))
      .setTextStyle(0, p.nome.length, SpreadsheetApp.newTextStyle().setBold(true).setFontSize(15).setForegroundColor(AZUL).setFontFamily('Montserrat').build())
      .build());
    r.getRange(lin, 6, 1, 3).merge().setValue(p.feitas + ' / ' + p.total + '  ·  ' + Math.round(pc * 100) + '%')
      .setFontSize(14).setFontWeight('bold').setFontColor(corDe(pc)).setHorizontalAlignment('right');
    r.getRange(lin, 2, 1, 7).setBackground(BRANCO).setBorder(true, null, null, null, null, null, corDe(pc), SpreadsheetApp.BorderStyle.SOLID_THICK);
    r.setRowHeight(lin, 36);
    lin++;
    // feitas
    r.getRange(lin, 2, 1, 7).merge().setValue('✅  VISTORIAS FEITAS (' + p.feitas + ')').setFontSize(9).setFontWeight('bold').setFontColor(OK).setBackground(BRANCO);
    lin++;
    if ((p.detalhe || []).length) {
      r.getRange(lin, 2, 1, 7).setValues([['Data', 'Dia', 'Condomínio', 'Entrada', 'Saída', 'Quem foi', 'Motivo']])
        .setFontWeight('bold').setFontSize(9).setFontColor(BRANCO).setBackground(AZUL).setHorizontalAlignment('center');
      r.getRange(lin, 4).setHorizontalAlignment('left'); r.getRange(lin, 8).setHorizontalAlignment('left');
      lin++;
      const linhas = p.detalhe.map((d) => [d.data, d.dia, d.condo, d.entrada || '—', d.saida || '—', d.quem, d.motivo || '']);
      r.getRange(lin, 2, linhas.length, 7).setValues(linhas).setBackground(BRANCO).setFontSize(10);
      r.getRange(lin, 2, linhas.length, 1).setFontWeight('bold');
      r.getRange(lin, 3, linhas.length, 1).setFontColor(SUAVE).setHorizontalAlignment('center');
      r.getRange(lin, 4, linhas.length, 1).setFontWeight('bold');
      r.getRange(lin, 5, linhas.length, 2).setHorizontalAlignment('center');
      r.getRange(lin, 8, linhas.length, 1).setFontColor(SUAVE).setFontSize(9).setWrap(true);
      for (let i = 1; i < linhas.length; i += 2) r.getRange(lin + i, 2, 1, 7).setBackground('#f7f9fc');
      lin += linhas.length;
    } else {
      r.getRange(lin, 2, 1, 7).merge().setValue('Nenhuma vistoria registrada na semana.').setFontColor(SUAVE).setBackground(BRANCO);
      lin++;
    }
    // a fazer
    r.getRange(lin, 2, 1, 7).merge().setValue('❌  A FAZER (' + (p.total - p.feitas) + ')').setFontSize(9).setFontWeight('bold').setFontColor(RUIM).setBackground(BRANCO);
    lin++;
    const texto = (p.pendentes || []).join('   ·   ') || '✓ Todos os condomínios vistoriados';
    r.getRange(lin, 2, 1, 7).merge().setValue(texto).setWrap(true).setFontSize(10)
      .setFontColor((p.pendentes || []).length ? '#a12020' : OK).setBackground((p.pendentes || []).length ? '#fdecea' : '#e6f4ea');
    r.setRowHeight(lin, Math.max(28, 18 * Math.ceil(texto.length / 120) + 10));
    lin += 2;
  });
  r.getRange(lin, 2, 1, 7).merge().setValue('Conta como vistoria a primeira ida da semana ao condomínio, de qualquer pessoa da equipe. * saída estimada. “(sem grupo)”: a IA não está no grupo do condomínio.')
    .setFontSize(8).setFontColor(SUAVE).setWrap(true);
}

// ---------------------------------------------------------------- aba Pendências
// Fichas de pendência levantadas nos grupos: abertas, atrasadas e concluídas nos últimos 90 dias.
function escreverPendencias(ss, P) {
  let r = ss.getSheetByName(ABA_PEND);
  if (!r) r = ss.insertSheet(ABA_PEND, 2);
  const COLS = ['#', 'Condomínio', 'Responsável', 'Pendência', 'Urgência', 'Situação', 'Levantada por', 'Aberta em', 'Prazo', 'Dias', 'Alpha disse', 'Conclusão'];
  const nc = COLS.length;
  if (r.getFilter()) r.getFilter().remove();
  r.getRange(1, 1, r.getMaxRows(), r.getMaxColumns()).breakApart();
  r.clear();
  r.clearConditionalFormatRules();
  if (r.getMaxColumns() < nc) r.insertColumnsAfter(r.getMaxColumns(), nc - r.getMaxColumns());
  r.setHiddenGridlines(true);
  [50, 170, 100, 280, 85, 105, 120, 100, 100, 50, 240, 220].forEach((w, i) => r.setColumnWidth(i + 1, w));
  r.getRange(1, 1, r.getMaxRows(), nc).setFontFamily('Roboto').setFontSize(10).setVerticalAlignment('middle').setFontColor(TEXTO);

  // cabeçalho e cartões
  r.getRange(1, 1, 1, nc).merge().setValue('Pendências levantadas nos grupos').setFontFamily('Montserrat').setFontSize(18).setFontWeight('bold')
    .setFontColor(BRANCO).setBackground(AZUL);
  r.getRange(2, 1, 1, nc).merge().setValue('Abertas e concluídas nos últimos 90 dias · a IA abre e acompanha cada pedido dos grupos · detalhe no WhatsApp: !pendencia número')
    .setFontSize(9).setFontColor('#c9d3e6').setBackground(AZUL);
  r.setRowHeight(1, 40); r.setRowHeight(2, 22);
  const abertas = P.filter((x) => ['Aberta', 'Encaminhada', 'Agendada', 'Atrasada'].indexOf(x.situacao) >= 0);
  const atr = P.filter((x) => x.situacao === 'Atrasada');
  const concl = P.filter((x) => x.situacao === 'Concluída');
  const media = concl.length ? (concl.reduce((t, x) => t + x.dias, 0) / concl.length).toFixed(1).replace('.', ',') + ' dias' : '—';
  const cart = [['ABERTAS', abertas.length, AZUL], ['ATRASADAS', atr.length, atr.length ? RUIM : OK], ['CONCLUÍDAS (90 DIAS)', concl.length, OK], ['TEMPO MÉDIO P/ RESOLVER', media, AZUL]];
  const posC = [[1, 3], [4, 4], [5, 7], [8, 10]];
  cart.forEach((c, i) => {
    const [a, b] = posC[i];
    r.getRange(4, a, 1, b - a + 1).merge().setValue(c[0]).setFontSize(8).setFontWeight('bold').setFontColor(SUAVE);
    r.getRange(5, a, 1, b - a + 1).merge().setValue(c[1]).setFontSize(22).setFontWeight('bold').setFontColor(c[2]).setFontFamily('Montserrat');
    r.getRange(4, a, 2, b - a + 1).setHorizontalAlignment('center').setBackground('#f3f6fb')
      .setBorder(true, true, true, true, null, null, LINHA, SpreadsheetApp.BorderStyle.SOLID);
    r.getRange(4, a, 2, 1).setBorder(null, true, null, null, null, null, c[2], SpreadsheetApp.BorderStyle.SOLID_THICK);
  });
  r.setRowHeight(5, 38);

  // tabela: atrasadas primeiro, depois abertas, depois concluídas
  const ordem = { Atrasada: 0, Aberta: 1, Encaminhada: 2, Agendada: 3, 'Concluída': 4, Descartada: 5 };
  const linhas = P.slice().sort((a, b) => (ordem[a.situacao] - ordem[b.situacao]) || (b.dias - a.dias))
    .map((x) => [x.id, x.condominio, x.responsavel, x.titulo + (x.detalhe ? '\n' + x.detalhe : ''), x.urgencia, x.situacao, x.autor,
      x.aberta, x.situacao === 'Agendada' && x.agendado ? 'agend. ' + x.agendado : x.prazo, x.dias, x.promessa, x.conclusao + (x.concluida ? ' (' + x.concluida + ')' : '')]);
  const h = 7;
  r.getRange(h, 1, 1, nc).setValues([COLS]).setFontWeight('bold').setFontSize(9).setFontColor(BRANCO).setBackground(AZUL).setHorizontalAlignment('center').setWrap(true);
  r.setRowHeight(h, 30);
  r.setFrozenRows(h);
  if (linhas.length) {
    r.getRange(h + 1, 1, linhas.length, nc).setNumberFormat('@').setValues(linhas.map((l) => l.map(String))).setBackground(BRANCO);
    r.getRange(h + 1, 1, linhas.length, 1).setHorizontalAlignment('center').setFontColor(SUAVE);
    r.getRange(h + 1, 2, linhas.length, 1).setFontWeight('bold');
    r.getRange(h + 1, 4, linhas.length, 1).setWrap(true);
    r.getRange(h + 1, 5, linhas.length, 6).setHorizontalAlignment('center');
    r.getRange(h + 1, 11, linhas.length, 2).setWrap(true).setFontSize(9).setFontColor('#4a5568');
    r.getRange(h, 1, linhas.length + 1, nc).createFilter();
  } else {
    r.getRange(h + 1, 1, 1, nc).merge().setValue('Nenhuma pendência registrada ainda. No WhatsApp: !pendencias analisar').setFontColor(SUAVE);
  }
  const n = Math.max(linhas.length, 1);
  const sit = r.getRange(h + 1, 6, n, 1), urg = r.getRange(h + 1, 5, n, 1);
  const regra = (rg, txt, fundo, cor) => SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(txt).setBackground(fundo).setFontColor(cor).setBold(true).setRanges([rg]).build();
  r.setConditionalFormatRules([
    regra(sit, 'Atrasada', '#fdecea', RUIM), regra(sit, 'Aberta', '#fff4cc', '#7f6000'), regra(sit, 'Encaminhada', '#e8f0fe', AZUL),
    regra(sit, 'Agendada', '#ede7f6', '#5e35b1'), regra(sit, 'Concluída', '#e6f4ea', OK), regra(sit, 'Descartada', CINZA, SUAVE),
    regra(urg, 'Urgente', '#fdecea', RUIM), regra(urg, 'Alta', '#fff1e6', '#c25e00'), regra(urg, 'Normal', '#fffbe6', '#7f6000'), regra(urg, 'Baixa', CINZA, SUAVE),
  ]);
}
