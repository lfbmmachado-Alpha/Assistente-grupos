# Assistente de grupos — guia do zero

O que ele faz: usa um **número próprio da IA**, que você adiciona nos grupos dos condomínios.
Ele lê os grupos (moradores, síndico, conselho) e as mensagens que moradores mandarem no privado **para esse número**,
e manda para um **grupo de sugestões** (você + o número da IA) um resumo do que precisa de resposta,
com uma sugestão pronta para copiar.

Ele **nunca escreve** nos grupos dos condomínios nem nos privados. Só escreve no grupo de sugestões.
Você responde normalmente, do seu número pessoal.

---

## Passo 1 — Colocar o código no GitHub
1. No repositório `condo-bot`, crie uma branch nova chamada `assistente-grupos`.
2. Suba esta pasta inteira nela (package.json, src/, README.md, .env.example, .gitignore).

> Alternativa: criar um repositório novo só para ele. Funciona igual.

## Passo 2 — Criar o serviço no Railway
1. No mesmo projeto do condo-bot: **New → GitHub Repo** → escolha o repositório e a branch `assistente-grupos`.
2. **New → Database → PostgreSQL** (cria o banco).
3. No serviço novo, aba **Variables**, preencha (modelo no `.env.example`):

| Variável | O que colocar |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (o Railway preenche sozinho) |
| `EVOLUTION_API_URL` | a mesma URL da Evolution que o condo-bot usa |
| `EVOLUTION_API_KEY` | a mesma apikey global |
| `EVOLUTION_INSTANCE` | `assistente-ia` (o nome da instância do passo 3) |
| `WEBHOOK_TOKEN` | uma senha longa qualquer, inventada por você |
| `GEMINI_API_KEY` | a mesma chave do Gemini do condo-bot |
| `EQUIPE_NUMEROS` | *(opcional)* números de outras pessoas da Alpha, com DDI e DDD, separados por vírgula. As respostas delas também fecham pendências. Você não precisa estar aqui. |

4. Aba **Settings → Networking → Generate Domain**. Anote o endereço (ex.: `assistente-grupos-production.up.railway.app`).
5. Abra esse endereço no navegador. Deve aparecer **assistente-grupos ok**.

## Passo 3 — Conectar o número da IA na Evolution
1. Coloque o chip num celular, instale o **WhatsApp Business** e ative o número.
   Em perfil, use um nome claro, como **"Alpha Condomínios · Assistente"**, e a logo da Alpha.
2. **Aqueça o número**: use normalmente por 3 a 5 dias (algumas conversas, entrar em 1 ou 2 grupos)
   antes de colocar em muitos grupos. Número novo que entra em dezenas de grupos no primeiro dia é banido com facilidade.
3. No painel da Evolution, crie uma **instância nova** chamada `assistente-ia`.
4. Gere o QR Code e leia com o celular da IA: **WhatsApp → Aparelhos conectados → Conectar aparelho**.
5. Nas **configurações da instância**:
   - `Ignorar grupos`: **desligado** (precisa receber os grupos)
   - `Sempre online`: **desligado**
   - `Marcar mensagens como lidas`: **desligado** (o morador não vê "lido" sem ninguém ter respondido)
   - `Rejeitar ligações`: **ligado**, com uma mensagem como "Este número não recebe ligações. Fale com a Alpha pelo (31) ...."
6. Em **Webhook** da instância:
   - URL: `https://SEU-ENDERECO-DO-PASSO-2/webhook/SEU_WEBHOOK_TOKEN`
   - Eventos: marque **MESSAGES_UPSERT** e **CONNECTION_UPDATE**
   - `Webhook by events`: desligado · `Webhook base64`: desligado
   - Ative o webhook e salve.

## Passo 4 — Criar o grupo de sugestões
1. Do **seu celular pessoal**, crie um grupo (ex.: "🤖 Sugestões") só com você e o **número da IA**.
2. Nesse grupo, envie do seu celular: **`!aqui`**
3. Ele responde "✅ Este grupo agora recebe as análises e sugestões".
   Nesse momento o seu número fica cadastrado como administrador: só você (e quem estiver em `EQUIPE_NUMEROS`)
   consegue usar comandos. Comando enviado por qualquer outra pessoa é ignorado.

## Passo 5 — Colocar a IA nos grupos do teste
Escolha de 3 a 5 condomínios e adicione o número da IA nos grupos deles (moradores, síndico e conselho).
Você precisa ser administrador do grupo para adicionar. Sugestão de aviso para o grupo de moradores:

> Olá! Adicionamos o assistente da Alpha Condomínios ao grupo. Ele nos ajuda a não deixar nenhuma
> dúvida sem resposta. Ele não responde mensagens: as respostas continuam vindo da nossa equipe.
> As mensagens são tratadas conforme a LGPD e apagadas após 90 dias.

## Passo 6 — Escolher os condomínios do teste
Tudo no grupo de sugestões, do seu celular:

```
!sincronizar                  ← lê os nomes dos grupos em que a IA está (não lê mensagens)
!condominios                  ← lista os condomínios encontrados
!teste incluir belinha        ← coloca no teste (aceita parte do nome, sem acento)
!teste incluir ametista
!teste                        ← confere a lista
```

O sistema começa em **modo teste**: só olha os condomínios da lista. Mensagens dos outros nem são gravadas.

Os ícones mostram quais grupos ele achou para cada condomínio: 👥 moradores · 🧑‍💼 síndico · 📊 conselho.
Se um grupo tiver nome fora do padrão, veja com `!outros` e classifique com `!vincular`.

---

## No dia a dia
Quando alguém pergunta algo, o sistema espera ~1,5 min (a pessoa terminar de escrever) e manda no seu grupo:

```
🟡 Belinha Ferrari
👥 Moradores · assembleia

👤 Maria 302 (26/10, 10:21):
Alguém sabe quando vai ser a assembleia?

📝 Quer saber a data da assembleia
🔎 No grupo do síndico foi falado em novembro.
💬 Sugestão na próxima mensagem 👇
```
e logo depois a sugestão sozinha, para você **copiar e colar** no grupo do condomínio.

- 🔴 alta · 🟡 média · 🟢 baixa urgência
- 🔎 é uma nota só para você (usa o que foi falado nos grupos de síndico e conselho). Nunca vai na sugestão.
- **Quando você responde citando a mensagem** (arrastar para o lado → responder), do seu número,
  a pendência fecha sozinha. Vale também para quem estiver em `EQUIPE_NUMEROS`.
- Se você já respondeu antes de o sistema analisar, ele não te notifica.

### Comandos
| Comando | O que faz |
|---|---|
| `!pendentes` | Lista o que está sem resposta (últimas 48h), numerado |
| `!ok 2` / `!ok todos` | Marca como resolvida a pendência 2 (ou todas) |
| `!status` | Modo, grupos conhecidos, mensagens e pendências |
| `!teste` · `!teste incluir X` · `!teste remover X` | Lista de condomínios em teste |
| `!modo producao` / `!modo teste` | Liberar todos os condomínios / voltar só para a lista |
| `!ignorar X` / `!ativar X` | Parar ou voltar a monitorar um condomínio |
| `!outros` · `!vincular N tipo Nome` | Grupos fora do padrão de nome |
| `!assinatura` · `!assinatura cristiana Ygor` · `!assinatura padrao Luiz` | Quem assina as sugestões |
| `!base Nome` | O que a IA já sabe do condomínio (fatos aprendidos) |
| `!fato Nome: texto` | Ensina um fato à mão |
| `!esquecer N` | Apaga o fato N da última `!base` |
| `!aprender` | Atualiza a base agora (roda sozinho a cada 3h) |
| PDF com legenda `!doc Nome Título` | Cadastra regimento, convenção, ata… |
| `!docs` · `!doc remover N` | Lista ou remove documentos |
| `!exemplos` | Quantas respostas da equipe já viraram exemplo |
| `!ajuda` | Mostra os comandos |

### Quais privados ele analisa
Só as mensagens enviadas **para o número da IA**, e só de pessoas que ele já viu escrevendo no grupo de
moradores de um condomínio monitorado. Os privados do **seu número pessoal ele não vê**.
Se um morador mandar mensagem no privado da IA, a sugestão chega no grupo, mas a resposta precisa ser dada
por você (do seu número) ou, se preferir, pelo celular da IA.

---

## Como ela aprende (sem responder sozinha)
- **Exemplos da equipe:** quando alguém da equipe responde um pedido (de preferência citando a mensagem),
  a pergunta e a resposta viram exemplo. As sugestões passam a imitar o tom e o jeito da equipe.
- **Base de conhecimento:** a cada 3 horas a IA lê as conversas novas de cada condomínio e guarda fatos duráveis
  (fornecedores, prazos, decisões, regras, andamentos com data). Nada de dados pessoais ou inadimplência.
  Confira com `!base Nome`, corrija com `!esquecer N` e ensine com `!fato Nome: texto`.
- **Documentos:** mande o PDF no grupo de sugestões com a legenda `!doc Nome Título`. As sugestões passam a
  consultar o texto e citar o artigo.

Ela continua **só sugerindo**: nunca escreve nos grupos dos condomínios.

## Controle de vistorias
A IA reconhece nos grupos dos condomínios (moradores, síndico ou conselho) os avisos da equipe:
"Estou no condomínio para a vistoria" → **entrada** · "Vistoria finalizada" → **saída**.
Vale para **todos** os grupos em que a IA estiver, mesmo fora do modo teste. Áudios também contam.

- A primeira visita da semana é **ordinária**; as demais, ou as que falam em emergência, vazamento, obra,
  assembleia ou chamado, são **extraordinárias**. Ordinária pendente só sai da lista com uma visita ordinária.
- Sem aviso de saída, a saída é estimada pela última mensagem do vistoriador no dia (marcada com *).
- **Sexta às 12h** chega no grupo de sugestões a lista de condomínios sem vistoria na semana.
- Cadastre condomínios e vistoriadores enviando a planilha (modelo: *Carteira de vistorias - modelo.xlsx*)
  com a legenda `!vistorias importar`. Condomínio da planilha sem grupo da IA aparece como ⚠️.

| Comando | O que faz |
|---|---|
| `!vistorias` | Situação da semana por vistoriador (✅ ❌ ⚠️) |
| `!vistorias pendentes` · `!vistorias passada` | Só o que falta · semana anterior |
| `!vistorias Nome` | Histórico de visitas de um condomínio |
| `!vistorias exportar [mm/aaaa]` | Planilha Excel com todas as visitas (entrada, saída, duração) |
| `!visita Nome dd/mm hh:mm-hh:mm Vistoriador [extra motivo]` | Lança ou corrige uma visita à mão |
| `!visita remover N` | Apaga a visita N listada em `!vistorias Nome` |
| `!vistoriadores` | Vistoriadores cadastrados |

Variáveis opcionais: `VISITAS_ALERTA_DIA` (5 = sexta) e `VISITAS_ALERTA_HORA` (12).

## Cuidados
- **Teste com 3 a 5 condomínios** por uma ou duas semanas antes do `!modo producao`. Observe: notificações
  desnecessárias, sugestões que **inventam informação** (o mais importante) e se a nota 🔎 ajuda.
- **LGPD**: as mensagens ficam no banco por 90 dias e depois são apagadas (`RETENTION_DAYS`).
  Vale um aviso nos grupos de que a administradora usa ferramenta de apoio no atendimento.
- **Banimento**: a Evolution usa uma conexão não oficial. Como a IA só **lê** e escreve apenas no grupo de sugestões,
  o risco é baixo, mas cresce se o número for colocado em muitos grupos de uma vez. Ao sair do teste,
  adicione em lotes (por exemplo, 20 grupos por dia).
- Se aparecer algo estranho, me mande um print da notificação que eu ajusto o prompt (`src/gemini.js`).

## Problemas comuns
| Sintoma | O que verificar |
|---|---|
| `!aqui` não responde | Webhook com a URL/token certos? Evento MESSAGES_UPSERT marcado? Veja os logs no Railway |
| Comandos pararam de responder | Mande do mesmo número que fez o primeiro `!aqui`. Se trocou de celular/número, coloque o novo em `EQUIPE_NUMEROS` |
| Nada é notificado | A IA está nos grupos? O condomínio está no `!teste`? A instância está conectada? |
| Condomínio aparece duas vezes | Grupos com nomes diferentes (ex.: "Ametista" e "Ed Ametista Torre 1"). Use `!outros`/`!vincular` |
| Erro "Gemini 400/403" nos logs | Chave do Gemini ou nome do modelo (`GEMINI_MODEL`) |
