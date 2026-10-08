# assistente-grupos

Conecta no seu número pessoal (como aparelho conectado, igual ao WhatsApp Web), lê **grupos e conversas privadas**,
guarda as mensagens, identifica o condomínio de cada grupo, classifica com o Gemini e manda **somente no seu grupo
de sugestões** tudo que precisa de resposta, com uma sugestão pronta para copiar.

O serviço **não tem nenhuma função para enviar mensagem a outro lugar**: a única saída é `sendToSuggestionGroup`.

## Como os grupos são ligados ao condomínio
O tipo e o condomínio saem do nome do grupo (acentos, maiúsculas e prefixos são ignorados):

| Nome do grupo | Tipo | Condomínio |
|---|---|---|
| Condomínio Belinha Ferrari | 👥 Moradores | Belinha Ferrari |
| Sindico-Belinha ferrari | 🧑‍💼 Síndico | Belinha Ferrari |
| Sind-Serra do capivari | 🧑‍💼 Síndico | Serra do Capivari |
| Conselho-Serra do Capivari | 📊 Conselho | Serra do Capivari |
| Conselho fiscal | 📊 Conselho | ⚠️ sem condomínio → `!vincular` |

Na análise, os grupos do mesmo condomínio se ajudam:
- mensagem no grupo de **moradores** → a IA vê o que foi falado nos grupos de síndico/conselho (30 dias),
  **sem revelar** isso na sugestão; o que for útil aparece como 🔎 nota interna só para você;
- mensagem no grupo do **síndico/conselho** → a IA vê o que os moradores estão falando (14 dias);
- **privado** → o condomínio é descoberto pelo grupo de moradores onde a pessoa escreve, e o grupo entra como contexto.

## 1. Railway
1. Serviço novo a partir deste repositório (ou branch separada, se ficar no repo do condo-bot).
2. Postgres no projeto; URL interna em `DATABASE_URL`.
3. Variáveis do `.env.example`.

## 2. Evolution API (instância nova no seu número)
Conecte pelo QR Code em *WhatsApp → Aparelhos conectados*. Configurações importantes no número pessoal:
`readMessages: false` (não marca como lida), `alwaysOnline: false` (não fica online o tempo todo),
`groupsIgnore: false` (recebe grupos).

```bash
curl -X POST "$EVOLUTION_URL/settings/set/luiz-pessoal" \
  -H "apikey: $EVOLUTION_API_KEY" -H "Content-Type: application/json" \
  -d '{"rejectCall":false,"groupsIgnore":false,"alwaysOnline":false,"readMessages":false,"readStatus":false,"syncFullHistory":false}'

curl -X POST "$EVOLUTION_URL/webhook/set/luiz-pessoal" \
  -H "apikey: $EVOLUTION_API_KEY" -H "Content-Type: application/json" \
  -d '{"webhook":{"enabled":true,"url":"https://SEU-APP.up.railway.app/webhook/SEU_WEBHOOK_TOKEN","byEvents":false,"base64":false,"events":["MESSAGES_UPSERT","GROUPS_UPSERT","GROUP_UPDATE"]}}'
```

## 3. Primeira configuração
1. Crie um grupo só com você (o app exige adicionar alguém na criação: adicione e remova).
2. Nele, envie `!aqui`. **Mande só ali** — num grupo de condomínio os moradores veriam.
3. Envie `!sincronizar`: importa todos os seus grupos e mostra quantos ficaram sem condomínio.
4. `!grupos sem` → resolva com `!vincular N Nome` (ex.: os "Conselho fiscal" sem nome).
5. Grupos pessoais (família, amigos) entram como moradores: `!tipo N outro` ou `!ignorar N`.
6. Conversas privadas pessoais: `!privados` e `!ignorar pN`.

## Modo teste (padrão)
O serviço **começa em modo teste**: só lê e analisa grupos e privados dos condomínios que você colocar na lista.
Mensagens dos demais nem são gravadas.

```
!aqui
!sincronizar
!condominios belinha          ← confere o nome
!teste incluir Belinha Ferrari
!teste incluir Serra do Capivari
!teste                        ← mostra o modo e a lista
```

Privados entram no teste quando a pessoa participa do grupo de moradores de um condomínio da lista
(o vínculo é feito pela primeira mensagem dela nesse grupo).

Quando estiver satisfeito: `!modo producao`. Para voltar: `!modo teste`.

## Comandos (no grupo de sugestões)
| Comando | O que faz |
|---|---|
| `!teste` | Mostra o modo e os condomínios em teste |
| `!teste incluir Nome` / `!teste remover Nome` | Coloca/tira condomínio do teste (aceita nome parcial ou número do `!grupos`) |
| `!modo teste` / `!modo producao` | Só a lista de teste, ou tudo |
| `!pendentes` | Sem resposta nas últimas 48h, por condomínio e tipo |
| `!sincronizar` | Importa e classifica todos os grupos |
| `!condominios [filtro]` | Condomínios e quais grupos cada um tem (👥🧑‍💼📊) |
| `!grupos [página \| filtro \| sem]` | Grupos numerados |
| `!privados [página \| filtro]` | Privados numerados (p1, p2…) |
| `!vincular N Nome` | Liga grupo/privado ao condomínio (vale para `pN`) |
| `!tipo N moradores\|sindico\|conselho\|outro` | Corrige o tipo |
| `!ignorar N` / `!ativar N` | Para / volta a monitorar (`pN` para privados) |

Vínculos e tipos definidos por comando não são sobrescritos quando o grupo é renomeado.

## Respostas
Quando **você** responde (grupo ou privado): se citou uma mensagem, só ela é fechada; se não citou, as pendências
das últimas 48h daquela conversa são fechadas. Suas respostas ficam salvas como histórico para as próximas fases.
Mensagens com mais de 90 dias são apagadas (`RETENTION_DAYS`).

## Limitações
- Áudios, figurinhas e mídias sem legenda não são analisados.
- Se você já rodou a versão anterior, as tabelas antigas (`groups`, `messages`) podem ser apagadas; esta usa `chats` e `chat_messages`.
