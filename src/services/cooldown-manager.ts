export class CooldownManager {
  private cooldowns: Map<string, Map<string, number>> = new Map();

  public isOnCooldown(
    userId: string,
    command: string,
    cooldownSeconds: number,
  ): boolean {
    const now = Date.now();
    const userCooldowns = this.cooldowns.get(userId) || new Map();
    const lastUsed = userCooldowns.get(command);

    if (!lastUsed) {
      return false;
    }

    const cooldownTime = lastUsed + cooldownSeconds * 1000;
    return now < cooldownTime;
  }

  public setCooldown(userId: string, command: string): void {
    const now = Date.now();
    const userCooldowns = this.cooldowns.get(userId) || new Map();
    userCooldowns.set(command, now);
    this.cooldowns.set(userId, userCooldowns);
  }

  public getRemainingCooldown(
    userId: string,
    command: string,
    cooldownSeconds: number,
  ): number {
    const userCooldowns = this.cooldowns.get(userId);
    if (!userCooldowns) {
      return 0;
    }

    const lastUsed = userCooldowns.get(command);
    if (!lastUsed) {
      return 0;
    }

    const cooldownTime = lastUsed + cooldownSeconds * 1000;
    const remaining = Math.ceil((cooldownTime - Date.now()) / 1000);
    return remaining > 0 ? remaining : 0;
  }

  public clearCooldown(userId: string, command: string): void {
    const userCooldowns = this.cooldowns.get(userId);
    if (userCooldowns) {
      userCooldowns.delete(command);
      if (userCooldowns.size === 0) {
        this.cooldowns.delete(userId);
      }
    }
  }

  public clearAllCooldowns(): void {
    this.cooldowns.clear();
  }
}
