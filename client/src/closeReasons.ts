/** Texto mostrado no menu quando o servidor encerra a conexão, pelo código de fechamento. */
export function lostMessage(code: number): string {
  switch (code) {
    case 1008:
      return 'Conexão encerrada: comandos demais em pouco tempo.';
    case 1011:
      return 'Erro no servidor. Tente de novo.';
    case 1012:
      return 'O servidor está reiniciando. Tente de novo em instantes.';
    case 4003:
      return 'Você ficou parado tempo demais na partida e um bot assumiu seu bicho.';
    case 4029:
      return 'Muitas conexões vindas da sua rede. Feche outras abas do jogo e tente de novo.';
    default:
      return 'A conexão caiu. Tente de novo.';
  }
}
