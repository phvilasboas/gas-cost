# GasCost

Aplicação web responsiva para acompanhar combustível, consumo e manutenção de um ou mais veículos. Os dados ficam persistidos em um volume do Docker.

O painel inclui:

- cadastro e edição de abastecimentos com data, hora opcional, hodômetro e tanque completo ou parcial;
- consumo médio em km/L, custo por quilômetro e aviso de queda de rendimento;
- preço médio geral e por combustível;
- vários veículos, cada um com seu próprio histórico;
- evolução mensal e comparação com o mês anterior;
- análise de preço por posto;
- manutenção, despesas e lembretes por data ou quilometragem;
- exportação em CSV e Excel, além do backup dos dados em JSON;
- instalação no celular ou computador como aplicativo, com atalho para um novo abastecimento.

## MCP remoto somente leitura

### Conectar pelo ChatGPT (OAuth)

Depois de publicar esta versão, crie novamente a conexão no ChatGPT:

- Server URL: `https://gascost.vilasboas.it/mcp`
- Authentication: `OAuth`
- Client ID e Client secret: **deixe vazios** (cadastro automático do cliente público com PKCE).
- Authorization URL e Token URL: deixe vazios para descoberta automática.
- Scopes, caso sejam solicitados: `gascost:fuel:read`, `gascost:maintenance:read` e `offline_access`, um por linha.

O ChatGPT abre o login do GasCost. Entre com a conta desejada e aprove as permissões exibidas. O token pessoal não deve ser colocado no campo Client secret.

A descoberta usa `/.well-known/oauth-authorization-server` e `/.well-known/oauth-protected-resource/mcp`. Os endpoints são `/oauth/authorize`, `/oauth/register`, `/oauth/token` e `/oauth/revoke`. O HAProxy deve encaminhar esses caminhos e `/.well-known/` à aplicação; configure a Cloudflare para respeitar `Cache-Control: no-store` nesses caminhos, em `/mcp` e `/api/`.

Os códigos duram 2 minutos, exigem PKCE S256 e são de uso único. Tokens de acesso duram até 1 hora; com `offline_access`, tokens de renovação são rotacionados a cada uso, por até 90 dias. Reutilizar um código ou token de renovação revoga a conexão correspondente. Apenas hashes dos códigos e tokens são persistidos. A aprovação é vinculada à sessão do usuário e protegida contra CSRF. Cada usuário pode desconectar o ChatGPT em **Perfil e MCP → ChatGPT**, invalidando acesso e renovação imediatamente.

O cadastro automático aceita somente retornos oficiais do ChatGPT, registrados com correspondência exata. Outros clientes continuam podendo usar os tokens pessoais descritos abaixo. Não há novo container ou serviço externo: os registros OAuth ficam no SQLite de autenticação existente. Faça backup do volume antes da atualização; a migração adiciona tabelas sem apagar os registros atuais.

### Tokens pessoais para outros clientes

O GasCost disponibiliza um servidor MCP Streamable HTTP em:

```text
https://gascost.vilasboas.it/mcp
```

Ele permite que clientes de IA consultem veículos, abastecimentos, resumos, ciclos de consumo, postos e manutenções. O MCP não possui ferramentas de criação, edição ou exclusão e não acessa senhas ou sessões.

Cada usuário cria o próprio token em **Perfil e MCP**. O token é mostrado uma única vez, armazenado apenas como hash no SQLite e deve ser enviado pelo cliente MCP em todas as requisições:

```text
Authorization: Bearer SEU_TOKEN_PESSOAL
```

Nunca coloque o token na URL nem reutilize `BOOTSTRAP_TOKEN`, usuário ou senha do painel. Cada token possui validade, permissões selecionadas e revogação independente. As consultas são sempre limitadas aos veículos pertencentes ao usuário que criou o token.

Ferramentas disponíveis:

- `listar_veiculos`
- `listar_abastecimentos`
- `obter_resumo_combustivel`
- `analisar_consumo`
- `analisar_postos`
- `listar_manutencoes`

Cada consulta aceita somente parâmetros validados, possui limites de resultados e é registrada no log sem gravar o conteúdo retornado. As permissões podem liberar separadamente combustível/análises e manutenções.

No primeiro acesso, a aplicação solicitará a criação da conta administradora. O administrador pode criar outros perfis em **Perfil e MCP**. Cada usuário possui dados e tokens MCP isolados. Usuários, senhas protegidas, sessões e hashes dos tokens ficam no SQLite `/app/data/auth.db`. Os veículos, abastecimentos e manutenções ficam no SQLite `/app/data/gascost.db`. Ambos permanecem no mesmo volume e no mesmo container.

Na primeira inicialização desta versão, todos os dados preexistentes são atribuídos automaticamente à conta administradora mais antiga. Novos usuários recebem um veículo inicial vazio e não conseguem consultar, alterar ou exportar registros de outra conta.

Ao iniciar a nova versão pela primeira vez, os abastecimentos que já existirem em `/app/data/fuel.json` serão importados automaticamente para o SQLite. O arquivo antigo é preservado e a importação não se repete.

## Executar com Docker

Crie o token usado somente para proteger a configuração da primeira conta:

```bash
cp .env.example .env
openssl rand -base64 32
```

Copie o valor gerado para `BOOTSTRAP_TOKEN` no arquivo `.env`. Em seguida:

```bash
docker compose up --build -d
```

A aplicação escuta somente em `127.0.0.1:3004` e espera ser acessada externamente por [https://gascost.vilasboas.it](https://gascost.vilasboas.it), através do HAProxy. No primeiro acesso, informe também o token definido no `.env`.

Para encerrar:

```bash
docker compose down
```

O comando acima preserva os dados. Para também remover todos os registros, use `docker compose down -v`.

### Uso em um domínio com HTTPS

Os controles de produção já estão ativos no `compose.yaml`: cookie exclusivo para HTTPS, validação do domínio e da origem, suporte ao IP encaminhado pelo proxy, porta local e privilégios reduzidos do container.

Um trecho de referência para o HAProxy está em `deploy/haproxy-gascost.cfg`. Incorpore as regras compatíveis ao `haproxy.cfg` do host e valide a configuração antes de recarregá-lo.

Depois de criar a conta administradora, você pode apagar `BOOTSTRAP_TOKEN` do `.env` e recriar o container. A conta e os dados continuarão preservados no volume.

## Desenvolvimento local

Requer Node.js 22.13 ou superior. Instale as dependências com `npm ci`.

Para executar fora do container, as variáveis de produção devem ser ajustadas ou removidas, pois o domínio publicado e o cookie HTTPS não funcionam em uma URL HTTP local.

```bash
npm run dev
```

Testes:

```bash
npm test
```
