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
const ABA_LISTAS = '_Listas'; // lista de condomínios para os menus de escolha (aba oculta)
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
  escreverListas(ss, linhas.map((l) => l[5]));
  const filtroPainel = escreverPainel(ss, dados.painel || {}, quando);
  if (!ss.getSheetByName(ABA_ASSEMBLEIA)) criarAssembleia(ss);
  ss.getSheetByName(ABA_ASSEMBLEIA).getRange('H2').setValue('Atualizado em ' + quando);
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
  const barra = (f, t, cor) => '=SPARKLINE(' + Math.round(f) + ', {"charttype","bar";"max",' + Math.max(1, Math.round(t)) + ';"color1","' + cor + '";"empty","zero"})';

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
    r.getRange(lin, PC.PCT).setNumberFormat('0%').setFontWeight('bold').setFontColor(corDe(x));
    F(r.getRange(lin, PC.BARRA), barra(f, t, corDe(x)));
    r.getRange(lin, listas, 1, PC.LISTA2 - listas + 1).setWrap(true).setFontSize(9).setFontColor(SUAVE).setVerticalAlignment('middle');
    lin++;
  };
  const total = (rot, f, t, extra) => {
    const x = pct(f, t);
    r.getRange(lin, PC.NOME, 1, 4).setValues([[rot, f, t, x]]).setFontWeight('bold').setBackground('#e8edf6');
    r.getRange(lin, PC.FEITAS, 1, 3).setHorizontalAlignment('center');
    r.getRange(lin, PC.PCT).setNumberFormat('0%').setFontColor(corDe(x));
    F(r.getRange(lin, PC.BARRA), barra(f, t, corDe(x)));
    r.getRange(lin, PC.BARRA, 1, PC.LISTA2 - PC.BARRA + 1).setBackground('#e8edf6');
    if (extra != null) r.getRange(lin, PC.EXTRA).setValue(extra).setHorizontalAlignment('center').setFontWeight('bold');
    r.setRowHeight(lin, 28);
    lin++;
  };

  // ---- gráficos (dados na aba oculta _Listas)
  const lst = ss.getSheetByName(ABA_LISTAS);
  lst.getRange('C1:H60').clearContent();
  const dv = [['Colaborador', 'Feitas', 'Pendentes']].concat((V.pessoas || []).map((p) => [p.nome, p.feitas, p.total - p.feitas]));
  const dl = [['Responsável', 'Feitas', 'A fazer']].concat((L.pessoas || []).map((p) => [p.nome, p.feitas, p.total - p.feitas]));
  lst.getRange(1, 3, dv.length, 3).setValues(dv);
  lst.getRange(1, 7, dl.length, 3).setValues(dl);
  SpreadsheetApp.flush(); // os dados precisam estar gravados antes de o gráfico ler
  // a aba _Listas é oculta: sem SHOW_BOTH o gráfico ignora dados ocultos e fica em branco
  const grafico = (range, titulo, linha, coluna, largura) => r.insertChart(r.newChart()
    .setChartType(Charts.ChartType.BAR).addRange(range).setNumHeaders(1)
    .setHiddenDimensionStrategy(Charts.ChartHiddenDimensionStrategy.SHOW_BOTH)
    .setOption('isStacked', true).setOption('title', titulo)
    .setOption('titleTextStyle', { color: TEXTO, fontSize: 13, bold: true })
    .setOption('colors', [OK, '#e57373']).setOption('legend', { position: 'top', textStyle: { color: SUAVE } })
    .setOption('backgroundColor', BRANCO).setOption('chartArea', { left: 110, top: 50, width: '70%', height: '75%' })
    .setOption('hAxis', { textStyle: { color: SUAVE }, gridlines: { color: LINHA } })
    .setOption('vAxis', { textStyle: { color: TEXTO } })
    .setOption('width', largura).setOption('height', 260)
    .setPosition(linha, coluna, 0, 0).build());
  secao('Visão geral');
  grafico(lst.getRange(1, 3, dv.length, 3), 'Vistorias da semana por colaborador', lin, PC.NOME, 560);
  grafico(lst.getRange(1, 7, dl.length, 3), 'Leituras do mês por responsável', lin, PC.BARRA + 1, 560);
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
  secao('Idas por condomínio', 'escolha o condomínio e o período nas células amarelas');
  const f0 = lin;
  r.getRange(lin, PC.NOME, 3, 1).setValues([['Condomínio'], ['De'], ['Até']]).setFontWeight('bold').setHorizontalAlignment('right')
    .setBackground(BRANCO);
  r.getRange(lin, PC.FEITAS, 1, 4).merge();
  r.getRange(lin + 1, PC.FEITAS, 1, 2).merge();
  r.getRange(lin + 2, PC.FEITAS, 1, 2).merge();
  const hoje = new Date();
  r.getRange(lin, PC.FEITAS).setValue(filtro.condo || lst.getRange('A2').getValue() || '');
  r.getRange(lin + 1, PC.FEITAS).setValue(filtro.de || new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1)).setNumberFormat('dd/mm/yyyy');
  r.getRange(lin + 2, PC.FEITAS).setValue(filtro.ate || new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate())).setNumberFormat('dd/mm/yyyy');
  r.getRange(lin, PC.FEITAS, 3, 4).setBackground('#fff4cc').setFontWeight('bold').setHorizontalAlignment('left')
    .setBorder(true, true, true, true, true, true, '#e0c060', SpreadsheetApp.BorderStyle.SOLID);
  r.getRange(lin, PC.FEITAS).setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInRange(lst.getRange('A2:A'), true).setAllowInvalid(false).build());
  r.getRange(lin + 1, PC.FEITAS, 2, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireDate().setAllowInvalid(false).build());
  const C = '$C$' + f0, D = '$C$' + (f0 + 1), A = '$C$' + (f0 + 2);
  // indicadores do condomínio escolhido
  const cond = ABA + '!F2:F, ' + C + ', ' + ABA + '!B2:B, ">="&' + D + ', ' + ABA + '!B2:B, "<="&' + A;
  r.getRange(lin, PC.EXTRA, 1, 1).setValue('Vistorias').setFontSize(8).setFontColor(SUAVE).setHorizontalAlignment('center');
  r.getRange(lin, PC.LISTA, 1, 1).setValue('Idas extras').setFontSize(8).setFontColor(SUAVE).setHorizontalAlignment('center');
  r.getRange(lin, PC.LISTA2, 1, 1).setValue('Total de idas').setFontSize(8).setFontColor(SUAVE).setHorizontalAlignment('center');
  F(r.getRange(lin + 1, PC.EXTRA), '=IF(' + C + '="", "", COUNTIFS(' + cond + ', ' + ABA + '!I2:I, "Vistoria da semana"))');
  F(r.getRange(lin + 1, PC.LISTA), '=IF(' + C + '="", "", COUNTIFS(' + cond + ', ' + ABA + '!I2:I, "Ida extra"))');
  F(r.getRange(lin + 1, PC.LISTA2), '=IF(' + C + '="", "", COUNTIFS(' + cond + '))');
  r.getRange(lin, PC.EXTRA, 3, 3).setBackground(BRANCO).setBorder(true, true, true, true, null, null, LINHA, SpreadsheetApp.BorderStyle.SOLID);
  r.getRange(lin + 1, PC.EXTRA, 2, 3).mergeVertically().setFontSize(22).setFontWeight('bold').setFontColor(AZUL)
    .setFontFamily('Montserrat').setHorizontalAlignment('center');
  for (let i = 0; i < 3; i++) r.setRowHeight(lin + i, 26);
  lin += 4;
  cab(['Data', 'Dia', 'Quem foi', 'Tipo', 'Entrada', 'Saída', 'Motivo / causa', 'Observação']);
  r.getRange(lin - 1, PC.LISTA, 1, 2).setHorizontalAlignment('left');
  const col = (c) => ABA + '!' + c + '2:' + c;
  F(r.getRange(lin, PC.NOME), '=IF(' + C + '="", "Escolha o condomínio", IFERROR(SORT(FILTER({' +
    ['B', 'C', 'H', 'I', 'K', 'L', 'J', 'Q'].map(col).join(', ') + '}, ' +
    col('F') + '=' + C + ', ' + col('B') + '>=' + D + ', ' + col('B') + '<=' + A + '), 1, FALSE), "Nenhuma ida no período."))');
  const n = 200;
  r.getRange(lin, PC.NOME, n, 8).setBackground(BRANCO).setFontSize(10);
  r.getRange(lin, PC.NOME, n, 1).setNumberFormat('dd/mm/yyyy').setHorizontalAlignment('left');
  r.getRange(lin, PC.FEITAS, n, 5).setHorizontalAlignment('center');
  r.getRange(lin, PC.LISTA, n, 2).setWrap(true).setFontColor('#4a5568');
  r.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Vistoria da semana').setBackground(VERDE).setFontColor('#2e6b1f').setRanges([r.getRange(lin, PC.PCT, n, 1)]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Ida extra').setBackground(LARANJA).setFontColor('#9c4a0f').setRanges([r.getRange(lin, PC.PCT, n, 1)]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=AND($B' + lin + '<>"", ISEVEN(ROW()))').setBackground('#f7f9fc').setRanges([r.getRange(lin, PC.NOME, n, 8)]).build(),
  ]);
  r.setFrozenRows(0);
  return r.getRange(f0, PC.FEITAS, 3, 1); // células do filtro (ficam liberadas para edição)
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
