export function getPlans() {
  return {
    'free': {
      name: 'Free',
      price: 0,
      cpu_cores: 0.5,
      ram_mb: 2048,
      session_secs: 3600,
      slots: 1,
      file_manager: false,
      storage_mb: 100,
      color: '#64748b',
    },
    'basic': {
      name: 'Basic',
      price: 99,
      cpu_cores: 1,
      ram_mb: 4096,
      session_secs: 10800,
      slots: 2,
      file_manager: false,
      storage_mb: 3072,
      color: '#3b82f6',
    },
    'pro': {
      name: 'Pro',
      price: 299,
      cpu_cores: 2,
      ram_mb: 8192,
      session_secs: 21600,
      slots: 3,
      file_manager: true,
      storage_mb: 4096,
      color: '#8b5cf6',
    },
    'enterprise': {
      name: 'Enterprise',
      price: 799,
      cpu_cores: 4,
      ram_mb: 16384,
      session_secs: 21600,
      slots: 4,
      file_manager: true,
      storage_mb: 5120,
      color: '#f59e0b',
    }
  };
}
