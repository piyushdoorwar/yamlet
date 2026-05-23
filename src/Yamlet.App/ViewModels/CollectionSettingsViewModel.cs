using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Yamlet.App.Models;
using Yamlet.App.Services;

namespace Yamlet.App.ViewModels;

/// <summary>Edits settings that live on a collection metadata file.</summary>
public sealed partial class CollectionSettingsViewModel : ViewModelBase
{
    private readonly YamletCollection _collection;
    private readonly CollectionService _collectionService;
    private readonly Action<string>? _status;

    public IReadOnlyList<LabeledOption<YamletAuthType>> AuthTypes { get; } = new[]
    {
        new LabeledOption<YamletAuthType>("No Auth", YamletAuthType.None),
        new LabeledOption<YamletAuthType>("Bearer Token", YamletAuthType.Bearer),
        new LabeledOption<YamletAuthType>("Cookie", YamletAuthType.Cookie),
    };

    public CollectionSettingsViewModel(
        YamletCollection collection,
        CollectionService collectionService,
        Action<string>? status = null)
    {
        _collection = collection;
        _collectionService = collectionService;
        _status = status;

        Name = collection.Name;
        SelectedAuthType = AuthTypes.FirstOrDefault(a => a.Value == collection.Auth.Type) ?? AuthTypes[0];
        BearerToken = collection.Auth.Token;
        Cookie = collection.Auth.Cookie;
    }

    [ObservableProperty]
    private string _name = string.Empty;

    [ObservableProperty]
    private LabeledOption<YamletAuthType> _selectedAuthType = null!;

    [ObservableProperty]
    private string _bearerToken = string.Empty;

    [ObservableProperty]
    private string _cookie = string.Empty;

    public bool IsBearerVisible => SelectedAuthType.Value == YamletAuthType.Bearer;
    public bool IsCookieVisible => SelectedAuthType.Value == YamletAuthType.Cookie;
    public bool HasAuth => SelectedAuthType.Value != YamletAuthType.None;

    partial void OnSelectedAuthTypeChanged(LabeledOption<YamletAuthType> value)
    {
        OnPropertyChanged(nameof(IsBearerVisible));
        OnPropertyChanged(nameof(IsCookieVisible));
        OnPropertyChanged(nameof(HasAuth));
    }

    [RelayCommand]
    private async Task SaveAsync()
    {
        _collection.Name = Name;
        _collection.Auth = new YamletAuth
        {
            Type = SelectedAuthType.Value,
            Token = BearerToken,
            Cookie = Cookie,
        };

        try
        {
            await _collectionService.SaveCollectionAsync(_collection);
            _status?.Invoke($"Saved {Name}");
        }
        catch (Exception ex)
        {
            _status?.Invoke($"Save failed: {ex.Message}");
        }
    }
}
