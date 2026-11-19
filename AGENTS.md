# Minha Nota Fiscal · manual da pasta

> O `CLAUDE.md` (Claude Code) e o `AGENTS.md` (Codex) têm o mesmo conteúdo. Se mudar um, mude o outro.

Esta pasta emite **nota fiscal de serviço (NFS-e)** da empresa de quem a usa, pelo **Sistema Nacional NFS-e** (o
Emissor Nacional), direto na API oficial do governo, com o **certificado digital A1** da empresa. Não tem servidor,
mensalidade nem custo por nota.

Fale com a pessoa em português do Brasil, frases curtas, sem jargão. Ela não precisa saber programar.

## O que fazer

Para qualquer pedido sobre nota fiscal (configurar, emitir, consultar, PDF, cancelar), siga a skill **nota-fiscal**:
`.claude/skills/nota-fiscal/SKILL.md` (Claude Code) ou `.agents/skills/nota-fiscal/SKILL.md` (Codex). O texto é
o mesmo. Se a skill não carregar sozinha, leia o arquivo e siga.

## Regras de ouro

1. **Nada é emitido sem o OK explícito da pessoa** no resumo da prévia. Cancelar também.
2. **A senha do certificado nunca passa pelo chat** (entra pela janela do `guardar-senha` e fica no Keychain).
3. **`certificado/`, `empresa.json` e `notas/` nunca saem do computador:** sem commit, sem upload, sem colar no chat.
4. **Nunca invente dado fiscal** (valor, alíquota, código de serviço, regime). Pergunte.
5. **Primeiro o ambiente de testes.** Produção só quando a pessoa pedir, depois de um teste certo.
6. **Não altere `ferramentas/nfse.mjs`** para fazer uma nota passar. Se o governo recusar, mostre o erro e a dica.

## Mapa

```
minha-nota-fiscal/
├── CLAUDE.md / AGENTS.md          este manual
├── README.md / PROMPT.md           o que é, como começar e o prompt inicial
├── empresa.exemplo.json           modelo do cadastro (o empresa.json de verdade fica fora do Git)
├── certificado/                   o .pfx da empresa (fora do Git)
├── notas/                         uma pasta por nota: resumo, XML, PDF (fora do Git)
├── ferramentas/nfse.mjs           a ferramenta pronta (assina e envia)
├── ferramentas/tabelas/           cidades (IBGE), serviços e NBS oficiais
├── ferramentas/esquemas/          modelos oficiais (XSD) do governo
├── fonte/                         código-fonte da ferramenta (para quem quiser conferir ou melhorar)
└── .claude/skills/ e .agents/skills/   a skill nota-fiscal
```
