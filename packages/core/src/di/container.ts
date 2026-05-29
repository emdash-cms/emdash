type Constructor<T = any> = new (...args: any[]) => T;
type Factory<T = any> = () => T;

class Container {
  private services = new Map<string, Constructor | Factory>();
  private instances = new Map<string, any>();
  private singletons = new Set<string>();

  register<T>(token: string, service: Constructor<T> | Factory<T>, singleton = false): void {
    this.services.set(token, service);
    if (singleton) {
      this.singletons.add(token);
    }
  }

  resolve<T>(token: string): T {
    if (this.instances.has(token)) {
      return this.instances.get(token);
    }

    const service = this.services.get(token);
    if (!service) {
      throw new Error(`Service not registered: ${token}`);
    }

    const instance = typeof service === 'function'
      ? new (service as Constructor<T>)()
      : (service as Factory<T>)();

    if (this.singletons.has(token)) {
      this.instances.set(token, instance);
    }

    return instance;
  }

  has(token: string): boolean {
    return this.services.has(token);
  }

  clear(): void {
    this.services.clear();
    this.instances.clear();
    this.singletons.clear();
  }
}

export const container = new Container();
export { Container };
